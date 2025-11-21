#[allow(duplicate_alias)]
module datahaven::coordinator {
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::balance::{Self, Balance};
    use sui::tx_context::{Self, TxContext};
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::table::{Self, Table};

    // ==================== Error Codes ====================
    
    const EUnauthorized: u64 = 1;
    const EInvalidStatus: u64 = 2;
    const EPaused: u64 = 3;
    const EInvalidChain: u64 = 4;
    const ERequestNotFound: u64 = 5;
    const EInvalidAccessPolicy: u64 = 8;
    const EDuplicateRequest: u64 = 9;
    const EInsufficientPayment: u64 = 10;

    // ==================== Constants ====================
    
    const CHAIN_ETHEREUM: u8 = 1;
    const CHAIN_SOLANA: u8 = 2;
    const CHAIN_SUI: u8 = 3;
    
    const STATUS_PENDING: u8 = 0;
    const STATUS_CONFIRMED: u8 = 1;
    const STATUS_FAILED: u8 = 2;
    const STATUS_REVOKED: u8 = 3;
    
    const ACCESS_POLICY_PUBLIC: u8 = 0;
    const ACCESS_POLICY_PRIVATE: u8 = 1;
    const ACCESS_POLICY_WHITELIST: u8 = 2;
    const ACCESS_POLICY_TOKEN_GATED: u8 = 3;
    
    const MIN_STORAGE_PAYMENT: u64 = 1_000_000; // 0.001 SUI

    // ==================== Structs ====================
    
    /// Global coordinator state
    public struct CoordinatorState has key {
        id: UID,
        admin: address,
        relayer: address,
        paused: bool,
        total_requests: u64,
        total_storage_bytes: u64,
        treasury: Balance<SUI>,
        supported_chains: vector<u8>,
        request_registry: Table<vector<u8>, ID>, // origin_request_id -> StorageRequest ID
    }
    
    /// Storage request from any origin chain
    public struct StorageRequest has key, store {
        id: UID,
        origin_chain: u8,
        origin_request_id: vector<u8>,
        user: address,
        data_hash: vector<u8>,
        walrus_blob_id: vector<u8>,
        zk_proof: vector<u8>,
        access_policy: AccessPolicy,
        status: u8,
        payment_amount: u64,
        storage_epochs: u64,
        created_at: u64,
        confirmed_at: u64,
    }
    
    /// Access control policy for data retrieval
    public struct AccessPolicy has store, drop, copy {
        policy_type: u8,
        owner: address,
        allowed_addresses: vector<address>,
        required_token_amount: u64,
        expiry_timestamp: u64,
    }
    
    /// Retrieval request record
    public struct RetrievalRequest has key, store {
        id: UID,
        storage_request_id: ID,
        accessor: address,
        access_proof: vector<u8>,
        integrity_proof: vector<u8>,
        retrieved_at: u64,
    }
    
    /// Access token for authorized retrieval
    public struct AccessToken has key, store {
        id: UID,
        storage_request_id: ID,
        holder: address,
        granted_by: address,
        expires_at: u64,
    }

    // ==================== Events ====================
    
    public struct StorageRequestProcessed has copy, drop {
        request_id: ID,
        origin_chain: u8,
        origin_request_id: vector<u8>,
        user: address,
        data_hash: vector<u8>,
        walrus_blob_id: vector<u8>,
        payment: u64,
        timestamp: u64,
    }
    
    public struct StorageConfirmed has copy, drop {
        request_id: ID,
        walrus_blob_id: vector<u8>,
        zk_proof_hash: vector<u8>,
    }
    
    public struct StorageFailed has copy, drop {
        request_id: ID,
        reason: vector<u8>,
    }
    
    public struct AccessGranted has copy, drop {
        request_id: ID,
        accessor: address,
        granted_at: u64,
    }
    
    public struct AccessRevoked has copy, drop {
        request_id: ID,
        revoked_by: address,
    }
    
    public struct DataRetrieved has copy, drop {
        request_id: ID,
        retrieval_id: ID,
        accessor: address,
        timestamp: u64,
    }

    // ==================== Init ====================
    
    fun init(ctx: &mut TxContext) {
        let mut supported_chains = vector::empty<u8>();
        vector::push_back(&mut supported_chains, CHAIN_ETHEREUM);
        vector::push_back(&mut supported_chains, CHAIN_SOLANA);
        vector::push_back(&mut supported_chains, CHAIN_SUI);
        
        let state = CoordinatorState {
            id: object::new(ctx),
            admin: tx_context::sender(ctx),
            relayer: tx_context::sender(ctx),
            paused: false,
            total_requests: 0,
            total_storage_bytes: 0,
            treasury: balance::zero<SUI>(),
            supported_chains,
            request_registry: table::new(ctx),
        };
        
        transfer::share_object(state);
    }

    // ==================== Core Functions ====================
    
    /// Process storage request from origin chain
    public fun process_storage_request(
        state: &mut CoordinatorState,
        origin_chain: u8,
        origin_request_id: vector<u8>,
        user: address,
        data_hash: vector<u8>,
        walrus_blob_id: vector<u8>,
        zk_proof: vector<u8>,
        access_policy_type: u8,
        payment: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext
    ): ID {
        assert!(!state.paused, EPaused);
        assert!(tx_context::sender(ctx) == state.relayer, EUnauthorized);
        assert!(is_supported_chain(state, origin_chain), EInvalidChain);
        assert!(!table::contains(&state.request_registry, origin_request_id), EDuplicateRequest);
        
        let payment_value = coin::value(&payment);
        assert!(payment_value >= MIN_STORAGE_PAYMENT, EInsufficientPayment);
        
        // Store payment in treasury
        balance::join(&mut state.treasury, coin::into_balance(payment));
        
        // Calculate storage epochs based on payment
        let storage_epochs = calculate_storage_epochs(payment_value);
        
        // Create access policy
        let access_policy = AccessPolicy {
            policy_type: access_policy_type,
            owner: user,
            allowed_addresses: vector::empty<address>(),
            required_token_amount: 0,
            expiry_timestamp: 0,
        };
        
        // Create storage request
        let request = StorageRequest {
            id: object::new(ctx),
            origin_chain,
            origin_request_id,
            user,
            data_hash,
            walrus_blob_id,
            zk_proof,
            access_policy,
            status: STATUS_CONFIRMED,
            payment_amount: payment_value,
            storage_epochs,
            created_at: clock::timestamp_ms(clock),
            confirmed_at: clock::timestamp_ms(clock),
        };
        
        let request_id = object::uid_to_inner(&request.id);
        
        // Register in global registry
        table::add(&mut state.request_registry, origin_request_id, request_id);
        
        // Update statistics
        state.total_requests = state.total_requests + 1;
        state.total_storage_bytes = state.total_storage_bytes + vector::length(&data_hash);
        
        // Emit event
        event::emit(StorageRequestProcessed {
            request_id,
            origin_chain,
            origin_request_id,
            user,
            data_hash,
            walrus_blob_id,
            payment: payment_value,
            timestamp: clock::timestamp_ms(clock),
        });
        
        event::emit(StorageConfirmed {
            request_id,
            walrus_blob_id,
            zk_proof_hash: data_hash,
        });
        
        transfer::share_object(request);
        request_id
    }
    
    /// Validate access and create retrieval request
    public fun validate_access(
        state: &CoordinatorState,
        request: &StorageRequest,
        accessor: address,
        access_proof: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ): bool {
        assert!(!state.paused, EPaused);
        assert!(request.status == STATUS_CONFIRMED, EInvalidStatus);
        
        let has_access = check_access_policy(&request.access_policy, accessor, clock);
        
        if (has_access) {
            let retrieval = RetrievalRequest {
                id: object::new(ctx),
                storage_request_id: object::uid_to_inner(&request.id),
                accessor,
                access_proof,
                integrity_proof: vector::empty<u8>(),
                retrieved_at: clock::timestamp_ms(clock),
            };
            
            let retrieval_id = object::uid_to_inner(&retrieval.id);
            
            event::emit(AccessGranted {
                request_id: object::uid_to_inner(&request.id),
                accessor,
                granted_at: clock::timestamp_ms(clock),
            });
            
            event::emit(DataRetrieved {
                request_id: object::uid_to_inner(&request.id),
                retrieval_id,
                accessor,
                timestamp: clock::timestamp_ms(clock),
            });
            
            transfer::share_object(retrieval);
        };
        
        has_access
    }
    
    /// Revoke access to stored data
    public fun revoke_access(
        request: &mut StorageRequest,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == request.user, EUnauthorized);
        assert!(request.status == STATUS_CONFIRMED, EInvalidStatus);
        
        request.status = STATUS_REVOKED;
        
        event::emit(AccessRevoked {
            request_id: object::uid_to_inner(&request.id),
            revoked_by: request.user,
        });
    }
    
    /// Update access policy (owner only)
    public fun update_access_policy(
        request: &mut StorageRequest,
        new_policy_type: u8,
        allowed_addresses: vector<address>,
        required_token_amount: u64,
        expiry_timestamp: u64,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == request.user, EUnauthorized);
        assert!(request.status == STATUS_CONFIRMED, EInvalidStatus);
        assert!(is_valid_policy_type(new_policy_type), EInvalidAccessPolicy);
        
        request.access_policy = AccessPolicy {
            policy_type: new_policy_type,
            owner: request.user,
            allowed_addresses,
            required_token_amount,
            expiry_timestamp,
        };
    }
    
    /// Grant access token to specific address
    public fun grant_access_token(
        request: &StorageRequest,
        recipient: address,
        expiry: u64,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == request.user, EUnauthorized);
        assert!(request.status == STATUS_CONFIRMED, EInvalidStatus);
        
        let token = AccessToken {
            id: object::new(ctx),
            storage_request_id: object::uid_to_inner(&request.id),
            holder: recipient,
            granted_by: request.user,
            expires_at: expiry,
        };
        
        transfer::transfer(token, recipient);
    }
    
    /// Mark storage request as failed (relayer only)
    public fun mark_failed(
        state: &CoordinatorState,
        request: &mut StorageRequest,
        reason: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.relayer, EUnauthorized);
        assert!(request.status == STATUS_PENDING, EInvalidStatus);
        
        request.status = STATUS_FAILED;
        
        event::emit(StorageFailed {
            request_id: object::uid_to_inner(&request.id),
            reason,
        });
    }

    // ==================== Query Functions ====================
    
    /// Get storage request by origin request ID
    public fun get_request_by_origin_id(
        state: &CoordinatorState,
        origin_request_id: vector<u8>
    ): ID {
        assert!(table::contains(&state.request_registry, origin_request_id), ERequestNotFound);
        *table::borrow(&state.request_registry, origin_request_id)
    }
    
    /// Check if user has access to data
    public fun has_access(
        request: &StorageRequest,
        accessor: address,
        clock: &Clock
    ): bool {
        if (request.status != STATUS_CONFIRMED) {
            return false
        };
        
        check_access_policy(&request.access_policy, accessor, clock)
    }
    
    /// Get request details
    public fun get_request_info(request: &StorageRequest): (
        u8,              // origin_chain
        address,         // user
        vector<u8>,      // data_hash
        vector<u8>,      // walrus_blob_id
        u8,              // status
        u64,             // payment_amount
        u64,             // created_at
    ) {
        (
            request.origin_chain,
            request.user,
            request.data_hash,
            request.walrus_blob_id,
            request.status,
            request.payment_amount,
            request.created_at,
        )
    }

    // ==================== Admin Functions ====================
    
    /// Pause coordinator
    public fun pause(state: &mut CoordinatorState, ctx: &mut TxContext) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        state.paused = true;
    }
    
    /// Unpause coordinator
    public fun unpause(state: &mut CoordinatorState, ctx: &mut TxContext) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        state.paused = false;
    }
    
    /// Update relayer address
    public fun update_relayer(
        state: &mut CoordinatorState,
        new_relayer: address,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        state.relayer = new_relayer;
    }
    
    /// Add supported chain
    public fun add_supported_chain(
        state: &mut CoordinatorState,
        chain_id: u8,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        
        if (!vector::contains(&state.supported_chains, &chain_id)) {
            vector::push_back(&mut state.supported_chains, chain_id);
        };
    }
    
    /// Withdraw from treasury
    public fun withdraw_treasury(
        state: &mut CoordinatorState,
        amount: u64,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        
        let withdrawn = balance::split(&mut state.treasury, amount);
        let coin = coin::from_balance(withdrawn, ctx);
        transfer::public_transfer(coin, state.admin);
    }
    
    /// Transfer admin role
    public fun transfer_admin(
        state: &mut CoordinatorState,
        new_admin: address,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        state.admin = new_admin;
    }

    // ==================== Helper Functions ====================
    
    fun check_access_policy(
        policy: &AccessPolicy,
        accessor: address,
        clock: &Clock
    ): bool {
        // Check if policy expired
        if (policy.expiry_timestamp > 0 && clock::timestamp_ms(clock) > policy.expiry_timestamp) {
            return false
        };
        
        // Check policy type
        if (policy.policy_type == ACCESS_POLICY_PUBLIC) {
            return true
        } else if (policy.policy_type == ACCESS_POLICY_PRIVATE) {
            return accessor == policy.owner
        } else if (policy.policy_type == ACCESS_POLICY_WHITELIST) {
            return vector::contains(&policy.allowed_addresses, &accessor) || accessor == policy.owner
        };
        
        // TOKEN_GATED requires additional logic (not implemented here)
        false
    }
    
    fun is_supported_chain(state: &CoordinatorState, chain_id: u8): bool {
        vector::contains(&state.supported_chains, &chain_id)
    }
    
    fun is_valid_policy_type(policy_type: u8): bool {
        policy_type == ACCESS_POLICY_PUBLIC ||
        policy_type == ACCESS_POLICY_PRIVATE ||
        policy_type == ACCESS_POLICY_WHITELIST ||
        policy_type == ACCESS_POLICY_TOKEN_GATED
    }
    
    fun calculate_storage_epochs(payment: u64): u64 {
        // Simple calculation: 1 SUI = 100 epochs
        // Adjust based on Walrus pricing
        let base_epochs: u64 = 5;
        let sui_unit: u64 = 1_000_000_000; // 1 SUI in MIST
        
        if (payment >= sui_unit) {
            base_epochs + ((payment / sui_unit) * 100)
        } else {
            base_epochs
        }
    }

    // ==================== View Functions ====================
    
    public fun get_total_requests(state: &CoordinatorState): u64 {
        state.total_requests
    }
    
    public fun get_total_storage_bytes(state: &CoordinatorState): u64 {
        state.total_storage_bytes
    }
    
    public fun get_treasury_balance(state: &CoordinatorState): u64 {
        balance::value(&state.treasury)
    }
    
    public fun is_paused(state: &CoordinatorState): bool {
        state.paused
    }
    
    public fun get_request_status(request: &StorageRequest): u8 {
        request.status
    }
    
    public fun get_walrus_blob_id(request: &StorageRequest): vector<u8> {
        request.walrus_blob_id
    }
    
    public fun get_data_hash(request: &StorageRequest): vector<u8> {
        request.data_hash
    }

    // ==================== Test Only ====================
    
    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx);
    }
    
    #[test_only]
    public fun create_test_request(
        state: &mut CoordinatorState,
        user: address,
        ctx: &mut TxContext
    ): ID {
        let request = StorageRequest {
            id: object::new(ctx),
            origin_chain: CHAIN_ETHEREUM,
            origin_request_id: b"test_request_1",
            user,
            data_hash: b"test_hash",
            walrus_blob_id: b"test_blob",
            zk_proof: b"test_proof",
            access_policy: AccessPolicy {
                policy_type: ACCESS_POLICY_PUBLIC,
                owner: user,
                allowed_addresses: vector::empty<address>(),
                required_token_amount: 0,
                expiry_timestamp: 0,
            },
            status: STATUS_CONFIRMED,
            payment_amount: 1_000_000_000,
            storage_epochs: 5,
            created_at: 0,
            confirmed_at: 0,
        };
        
        let request_id = object::uid_to_inner(&request.id);
        table::add(&mut state.request_registry, b"test_request_1", request_id);
        transfer::share_object(request);
        request_id
    }
}