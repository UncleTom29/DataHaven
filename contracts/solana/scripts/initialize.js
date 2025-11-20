const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = anchor.web3;
const fs = require("fs");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DatahavenSolana;
  
  console.log("Initializing DataHaven Solana...");
  console.log("Program ID:", program.programId.toString());

  const [statePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    program.programId
  );

  const tx = await program.methods
    .initialize()
    .accounts({
      state: statePDA,
      admin: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("✅ Initialized. Transaction:", tx);
  console.log("State PDA:", statePDA.toString());

  const deploymentInfo = {
    network: "devnet", // or mainnet
    programId: program.programId.toString(),
    statePDA: statePDA.toString(),
    admin: provider.wallet.publicKey.toString(),
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(
    "../deployment-solana.json",
    JSON.stringify(deploymentInfo, null, 2)
  );
}

main().catch(console.error);
