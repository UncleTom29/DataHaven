module datahaven::origin {
    use sui::coin;
    use sui::sui::SUI;
    use sui::clock;
    use sui::event;

    // Errors
    const EUnauthorized: u64 = 1;
    const EInvalidStatus: u64 = 2;
    const EPaused: u64 = 3;
    const EInsufficientPayment: u64 = 4;

    // Constants
    const MIN_PAYMENT: u64 = 1_000_000; // 0.001 SUI

    // State - Add public visibility
    public struct State has key {
        id: object::UID,
        admin: address,
        relayer: address,
        paused: bool,
        count: u64,
    }

    // Request - Add public visibility
    public struct Request has key, store {
        id: object::UID,
        user: address,
        data_hash: vector<u8>,
        status: u8, // 0=Pending, 1=Confirmed, 2=Failed, 3=Revoked
        payment: u64,
        timestamp: u64,
    }

    // Events - Add public visibility
    public struct StorageRequested has copy, drop {
        request_id: address,
        user: address,
        data_hash: vector<u8>,
        payment: u64,
        timestamp: u64,
    }

    public struct StorageConfirmed has copy, drop {
        request_id: address,
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
        };
        transfer::share_object(state);
    }

    // Initiate storage - Remove entry modifier from public functions
    public fun initiate_storage(
        state: &mut State,
        data_hash: vector<u8>,
        payment: coin::Coin<SUI>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(!state.paused, EPaused);
        assert!(coin::value(&payment) >= MIN_PAYMENT, EInsufficientPayment);

        let request = Request {
            id: object::new(ctx),
            user: tx_context::sender(ctx),
            data_hash,
            status: 0,
            payment: coin::value(&payment),
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
        transfer::public_transfer(payment, state.admin);
        transfer::share_object(request);
    }

    // Confirm storage
    public fun confirm_storage(
        state: &State,
        request: &mut Request,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.relayer, EUnauthorized);
        assert!(request.status == 0, EInvalidStatus);
        
        request.status = 1;
        event::emit(StorageConfirmed {
            request_id: object::uid_to_address(&request.id),
        });
    }

    // Mark failed
    public fun mark_failed(
        state: &State,
        request: &mut Request,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == state.relayer, EUnauthorized);
        assert!(request.status == 0, EInvalidStatus);
        
        request.status = 2;
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

    #[test_only]
    public fun init_for_testing(ctx: &mut tx_context::TxContext) {
        init(ctx);
    }
}