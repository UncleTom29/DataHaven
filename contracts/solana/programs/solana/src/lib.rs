#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    keccak,
    ed25519_program,
    sysvar::instructions::{load_instruction_at_checked, ID as IX_ID},
};

declare_id!("GRLdEPx7n4g2kowPvfPrPWpToeap3sHbKSDe18bCLyU5");

#[program]
pub mod datahaven_solana {
    use super::*;
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.admin = ctx.accounts.admin.key();
        state.relayer = ctx.accounts.admin.key();
        state.paused = false;
        state.count = 0;
        Ok(())
    }
    pub fn initiate_storage(
        ctx: Context<InitiateStorage>,
        data_hash: [u8; 32],
        payment_amount: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require!(payment_amount >= MIN_PAYMENT, ErrorCode::InsufficientPayment);
        let user_ai = ctx.accounts.user.to_account_info();
        let vault_ai = ctx.accounts.vault.to_account_info();
        **user_ai.lamports.borrow_mut() -= payment_amount;
        **vault_ai.lamports.borrow_mut() += payment_amount;
        let req = &mut ctx.accounts.request;
        req.user = ctx.accounts.user.key();
        req.data_hash = data_hash;
        req.blob_id = [0u8; 32];
        req.sui_tx_hash = [0u8; 32];
        req.proof_hash = [0u8; 32];
        req.status = Status::Pending;
        req.payment = payment_amount;
        req.timestamp = Clock::get()?.unix_timestamp;
        ctx.accounts.state.count += 1;
        emit!(StorageRequested {
            request_id: req.key(),
            user: req.user,
            data_hash,
            payment: payment_amount,
            timestamp: req.timestamp,
        });
        Ok(())
    }
    pub fn verify_receipt(
        ctx: Context<UpdateStatus>,
        blob_id: [u8; 32],
        sui_tx_hash: [u8; 32],
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let req = &mut ctx.accounts.request;
        require!(req.status == Status::Pending, ErrorCode::InvalidStatus);
        
        // Build the message to verify
        let message = keccak::hashv(&[
            &req.key().to_bytes(),
            &blob_id,
            &sui_tx_hash,
            &proof_hash,
        ]).0;
        
        // Verify the Ed25519 signature using the instruction sysvar
        // The signature verification must be done via the Ed25519Program
        // which should be called before this instruction
        let ix_sysvar = &ctx.accounts.instruction_sysvar;
        
        // Load the previous instruction (should be Ed25519 verify)
        let ix = load_instruction_at_checked(0, ix_sysvar)?;
        
        // Verify it's the Ed25519 program
        require!(
            ix.program_id == ed25519_program::ID,
            ErrorCode::InvalidSignature
        );
        
        // Ed25519 instruction data format:
        // [0]: number of signatures (u8)
        // [1]: padding (u8)
        // [2..4]: signature offset (u16)
        // [4..6]: signature instruction index (u16)
        // [6..8]: public key offset (u16)
        // [8..10]: public key instruction index (u16)
        // [10..12]: message data offset (u16)
        // [12..14]: message data size (u16)
        // [14..16]: message instruction index (u16)
        
        require!(ix.data.len() >= 16, ErrorCode::InvalidSignature);
        
        // Verify the message matches what we expect
        let msg_start = u16::from_le_bytes([ix.data[10], ix.data[11]]) as usize;
        let msg_size = u16::from_le_bytes([ix.data[12], ix.data[13]]) as usize;
        
        require!(
            msg_size == 32 && 
            ix.data.len() >= msg_start + msg_size &&
            &ix.data[msg_start..msg_start + msg_size] == message.as_slice(),
            ErrorCode::InvalidSignature
        );
        
        // Verify the public key matches the relayer
        let pk_start = u16::from_le_bytes([ix.data[6], ix.data[7]]) as usize;
        require!(
            ix.data.len() >= pk_start + 32 &&
            &ix.data[pk_start..pk_start + 32] == ctx.accounts.state.relayer.as_ref(),
            ErrorCode::InvalidSignature
        );
        
        req.blob_id = blob_id;
        req.sui_tx_hash = sui_tx_hash;
        req.proof_hash = proof_hash;
        req.status = Status::Confirmed;
        emit!(StorageConfirmed {
            request_id: ctx.accounts.request.key(),
            blob_id,
            sui_tx_hash,
            proof_hash,
        });
        Ok(())
    }
    pub fn mark_failed(ctx: Context<MarkFailed>) -> Result<()> {
        let req = &mut ctx.accounts.request;
        require!(req.status == Status::Pending, ErrorCode::InvalidStatus);
        req.status = Status::Failed;
        let vault_ai = ctx.accounts.vault.to_account_info();
        let user_ai = ctx.accounts.user.to_account_info();
        **vault_ai.lamports.borrow_mut() -= req.payment;
        **user_ai.lamports.borrow_mut() += req.payment;
        emit!(RequestFailed {
            request_id: req.key()
        });
        Ok(())
    }
    pub fn revoke_access(ctx: Context<RevokeAccess>) -> Result<()> {
        let req = &mut ctx.accounts.request;
        require!(req.user == ctx.accounts.user.key(), ErrorCode::Unauthorized);
        require!(req.status == Status::Confirmed, ErrorCode::InvalidStatus);
        req.status = Status::Revoked;
        emit!(AccessRevoked {
            request_id: req.key()
        });
        Ok(())
    }
    pub fn pause(ctx: Context<AdminAction>) -> Result<()> {
        ctx.accounts.state.paused = true;
        Ok(())
    }
    pub fn unpause(ctx: Context<AdminAction>) -> Result<()> {
        ctx.accounts.state.paused = false;
        Ok(())
    }
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault_ai = ctx.accounts.vault.to_account_info();
        let admin_ai = ctx.accounts.admin.to_account_info();
        **vault_ai.lamports.borrow_mut() -= amount;
        **admin_ai.lamports.borrow_mut() += amount;
        Ok(())
    }
}

#[account]
pub struct State {
    pub admin: Pubkey,
    pub relayer: Pubkey,
    pub paused: bool,
    pub count: u64,
}
#[account]
pub struct Vault {}
#[account]
pub struct Request {
    pub user: Pubkey,
    pub data_hash: [u8; 32],
    pub blob_id: [u8; 32],
    pub sui_tx_hash: [u8; 32],
    pub proof_hash: [u8; 32],
    pub status: Status,
    pub payment: u64,
    pub timestamp: i64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum Status {
    Pending,
    Confirmed,
    Failed,
    Revoked,
}
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 1 + 8,
        seeds = [b"state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(
        init,
        payer = admin,
        space = 8,
        seeds = [b"vault"],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct InitiateStorage<'info> {
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, State>,
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 32 + 32 + 32 + 1 + 8 + 8,
        seeds = [b"request", user.key().as_ref(), &state.count.to_le_bytes()],
        bump
    )]
    pub request: Account<'info, Request>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct UpdateStatus<'info> {
    #[account(seeds = [b"state"], bump)]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub request: Account<'info, Request>,
    #[account(constraint = relayer.key() == state.relayer @ ErrorCode::Unauthorized)]
    pub relayer: Signer<'info>,
    /// CHECK: This is the instruction sysvar account
    #[account(address = IX_ID)]
    pub instruction_sysvar: AccountInfo<'info>,
}
#[derive(Accounts)]
pub struct MarkFailed<'info> {
    #[account(seeds = [b"state"], bump)]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub request: Account<'info, Request>,
    #[account(mut, constraint = user.key() == request.user @ ErrorCode::Unauthorized)]
    pub user: SystemAccount<'info>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, Vault>,
    #[account(constraint = relayer.key() == state.relayer @ ErrorCode::Unauthorized)]
    pub relayer: Signer<'info>,
}
#[derive(Accounts)]
pub struct RevokeAccess<'info> {
    #[account(mut, has_one = user)]
    pub request: Account<'info, Request>,
    pub user: Signer<'info>,
}
#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(mut, seeds = [b"state"], bump, has_one = admin)]
    pub state: Account<'info, State>,
    pub admin: Signer<'info>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"state"], bump, has_one = admin)]
    pub state: Account<'info, State>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub admin: Signer<'info>,
}
#[event]
pub struct StorageRequested {
    pub request_id: Pubkey,
    pub user: Pubkey,
    pub data_hash: [u8; 32],
    pub payment: u64,
    pub timestamp: i64,
}
#[event]
pub struct StorageConfirmed {
    pub request_id: Pubkey,
    pub blob_id: [u8; 32],
    pub sui_tx_hash: [u8; 32],
    pub proof_hash: [u8; 32],
}
#[event]
pub struct RequestFailed {
    pub request_id: Pubkey,
}
#[event]
pub struct AccessRevoked {
    pub request_id: Pubkey,
}
#[error_code]
pub enum ErrorCode {
    Paused,
    InsufficientPayment,
    InvalidStatus,
    Unauthorized,
    InvalidSignature,
}
const MIN_PAYMENT: u64 = 1_000_000;