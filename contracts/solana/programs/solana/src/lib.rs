
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
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
payment: u64,
) -> Result<()> {
require!(!ctx.accounts.state.paused, ErrorCode::Paused);
require!(payment >= MIN_PAYMENT, ErrorCode::InsufficientPayment);
// Transfer payment by directly modifying lamports
let user_ai = ctx.accounts.user.to_account_info();
let vault_ai = ctx.accounts.vault.to_account_info();
**user_ai.try_borrow_mut_lamports()? -= payment;
**vault_ai.try_borrow_mut_lamports()? += payment;
// Create request
let req = &mut ctx.accounts.request;
req.user = ctx.accounts.user.key();
req.data_hash = data_hash;
req.status = Status::Pending;
req.payment = payment;
req.timestamp = Clock::get()?.unix_timestamp;
ctx.accounts.state.count += 1;
emit!(StorageRequested {
request_id: req.key(),
user: req.user,
data_hash,
payment,
timestamp: req.timestamp,
});
Ok(())
}
pub fn confirm_storage(ctx: Context<UpdateStatus>) -> Result<()> {
require!(
ctx.accounts.request.status == Status::Pending,
ErrorCode::InvalidStatus
);
ctx.accounts.request.status = Status::Confirmed;
emit!(StorageConfirmed {
request_id: ctx.accounts.request.key()
});
Ok(())
}
pub fn mark_failed(ctx: Context<MarkFailed>) -> Result<()> {
let req = &mut ctx.accounts.request;
require!(req.status == Status::Pending, ErrorCode::InvalidStatus);
req.status = Status::Failed;
let vault_ai = ctx.accounts.vault.to_account_info();
let user_ai = ctx.accounts.user.to_account_info();
**vault_ai.try_borrow_mut_lamports()? -= req.payment;
**user_ai.try_borrow_mut_lamports()? += req.payment;
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
space = 8 + 32 + 32 + 1 + 8 + 8,
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
#[msg("Paused")]
Paused,
#[msg("Insufficient payment")]
InsufficientPayment,
#[msg("Invalid status")]
InvalidStatus,
#[msg("Unauthorized")]
Unauthorized,
}
const MIN_PAYMENT: u64 = 1_000_000;