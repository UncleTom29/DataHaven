#[allow(duplicate_alias)]
module datahaven::origin {
    use sui::coin;
    use sui::sui::SUI;
    use sui::clock;
    use sui::event;
    use sui::balance;
    use sui::tx_context;
    use sui::object;
    use sui::transfer;
    use sui::ecdsa_k1;
    use sui::hash;
    use sui::bcs;
    use sui::address;

    // Errors
    const EUnauthorized: u64 = 1;
    const EInvalidStatus: u64 = 2;
    const EPaused: u64 = 3;
    const EInsufficientPayment: u64 = 4;
    const EInvalidSignature: u64 = 5;

    // Constants
    const MIN_PAYMENT: u64 = 1_000_000;

    // State
    public struct State has key {
        id: object::UID,
        admin: address,
        relayer: address,
        paused: bool,
        count: u64,
        balance: balance::Balance<SUI>,
    }

    // Request
    public struct Request has key, store {
        id: object::UID,
        user: address,
        data_hash: vector<u8>,
        blob_id: vector<u8>,
        sui_tx_hash: vector<u8>,
        proof_hash: vector<u8>,
        status: u8, // 0=Pending, 1=Confirmed, 2=Failed, 3=Revoked
        payment: u64,
        timestamp: u64,
    }

    // Events
    public struct StorageRequested has copy, drop {
        request_id: address,
        user: address,
        data_hash: vector<u8>,
        payment: u64,
        timestamp: u64,
    }

    public struct StorageConfirmed has copy, drop {
        request_id: address,
        blob_id: vector<u8>,
        sui_tx_hash: vector<u8>,
        proof_hash: vector<u8>,
    }

    public struct RequestFailed has copy, drop {
        request_id: address,
    }

    public struct AccessRevoked has copy, drop {
        request_id: address,
    }

    // Init
    fun init(ctx: &mut tx_context::TxContext) {
        let state = State {
            id: object::new(ctx),
            admin: tx_context::sender(ctx),
            relayer: tx_context::sender(ctx),
            paused: false,
            count: 0,
            balance: balance::zero<SUI>(),
        };
        transfer::share_object(state);
    }

    // Initiate storage
    public fun initiate_storage(
        state: &mut State,
        data_hash: vector<u8>,
        payment: coin::Coin<SUI>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(!state.paused, EPaused);
        let payment_value = coin::value(&payment);
        assert!(payment_value >= MIN_PAYMENT, EInsufficientPayment);
        balance::join(&mut state.balance, coin::into_balance(payment));

        let request = Request {
            id: object::new(ctx),
            user: tx_context::sender(ctx),
            data_hash,
            blob_id: vector::empty(),
            sui_tx_hash: vector::empty(),
            proof_hash: vector::empty(),
            status: 0,
            payment: payment_value,
            timestamp: clock::timestamp_ms(clock),
        };

        let request_addr = object::uid_to_address(&request.id);

        event::emit(StorageRequested {
            request_id: request_addr,
            user: request.user,
            data_hash: request.data_hash,
            payment: request.payment,
            timestamp: request.timestamp,
        });

        state.count = state.count + 1;
        transfer::share_object(request);
    }

    // Verify receipt
    public fun verify_receipt(
        state: &State,
        request: &mut Request,
        blob_id: vector<u8>,
        sui_tx_hash: vector<u8>,
        proof_hash: vector<u8>,
        signature: vector<u8>,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.relayer, EUnauthorized);
        assert!(request.status == 0, EInvalidStatus);
        
        let request_addr = object::uid_to_address(&request.id);
        let request_addr_bytes = bcs::to_bytes(&request_addr);
        
        let mut message_parts = vector::empty<vector<u8>>();
        vector::push_back(&mut message_parts, request_addr_bytes);
        vector::push_back(&mut message_parts, blob_id);
        vector::push_back(&mut message_parts, sui_tx_hash);
        vector::push_back(&mut message_parts, proof_hash);
        
        let serialized_parts = bcs::to_bytes(&message_parts);
        let message = hash::keccak256(&serialized_parts);
        
        let pubkey = ecdsa_k1::secp256k1_ecrecover(&signature, &message, 0u8);
        
        let mut pubkey_with_flag = vector::empty<u8>();
        vector::push_back(&mut pubkey_with_flag, 0u8); // Secp256k1 flag
        vector::append(&mut pubkey_with_flag, pubkey);
        
        let hash_bytes = hash::blake2b256(&pubkey_with_flag);
        
        let mut addr_bytes = vector::empty<u8>();
        let mut i: u64 = 0;
        while (i < 32) {
            vector::push_back(&mut addr_bytes, *vector::borrow(&hash_bytes, i));
            i = i + 1;
        };
        
        let recovered = address::from_bytes(addr_bytes);
        assert!(recovered == state.relayer, EInvalidSignature);

        request.blob_id = blob_id;
        request.sui_tx_hash = sui_tx_hash;
        request.proof_hash = proof_hash;
        request.status = 1;
        
        event::emit(StorageConfirmed {
            request_id: object::uid_to_address(&request.id),
            blob_id,
            sui_tx_hash,
            proof_hash,
        });
    }

    // Mark failed
    public fun mark_failed(
        state: &mut State,
        request: &mut Request,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.relayer, EUnauthorized);
        assert!(request.status == 0, EInvalidStatus);
        
        request.status = 2;
        let refund_balance = balance::split(&mut state.balance, request.payment);
        let refund_coin: coin::Coin<SUI> = coin::from_balance(refund_balance, ctx);
        transfer::public_transfer(refund_coin, request.user);
        
        event::emit(RequestFailed {
            request_id: object::uid_to_address(&request.id),
        });
    }

    // Revoke access
    public fun revoke_access(
        request: &mut Request,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == request.user, EUnauthorized);
        assert!(request.status == 1, EInvalidStatus);
        
        request.status = 3;
        event::emit(AccessRevoked {
            request_id: object::uid_to_address(&request.id),
        });
    }

    // Admin functions
    public fun pause(state: &mut State, ctx: &mut tx_context::TxContext) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        state.paused = true;
    }

    public fun unpause(state: &mut State, ctx: &mut tx_context::TxContext) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        state.paused = false;
    }

    public fun update_relayer(
        state: &mut State,
        new_relayer: address,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        state.relayer = new_relayer;
    }

    public fun withdraw(
        state: &mut State,
        amount: u64,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.admin, EUnauthorized);
        let withdraw_balance = balance::split(&mut state.balance, amount);
        let withdraw_coin: coin::Coin<SUI> = coin::from_balance(withdraw_balance, ctx);
        transfer::public_transfer(withdraw_coin, state.admin);
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut tx_context::TxContext) {
        init(ctx);
    }
}