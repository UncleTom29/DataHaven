import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import * as fs from 'fs';
import * as path from 'path';

async function deploy() {
  const client = new SuiClient({ 
    url: process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io' 
  });

  const privateKey = process.env.SUI_PRIVATE_KEY;
  if (!privateKey) throw new Error("SUI_PRIVATE_KEY not set");

  const keypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));
  const address = keypair.toSuiAddress();

  console.log("Deploying from:", address);

  // Build first
  const { execSync } = require('child_process');
  execSync('sui move build', { stdio: 'inherit' });

  // Read compiled modules
  const modulesPath = path.join(__dirname, '../build/datahaven/bytecode_modules');
  const modules = fs.readdirSync(modulesPath)
    .filter(file => file.endsWith('.mv'))
    .map(file => Array.from(fs.readFileSync(path.join(modulesPath, file))));

  // Create publish transaction
  const tx = new Transaction();
  const [upgradeCap] = tx.publish({ modules, dependencies: ['0x1', '0x2'] });
  tx.transferObjects([upgradeCap], address);

  // Execute
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });

  console.log("✅ Published!");
  console.log("Transaction:", result.digest);

  const packageId = result.objectChanges?.find(
    c => c.type === 'published'
  )?.packageId;

  console.log("Package ID:", packageId);

  // Save deployment info
  const deploymentInfo = {
    network: "devnet",
    packageId,
    deployer: address,
    digest: result.digest,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(
    '../deployment-sui.json',
    JSON.stringify(deploymentInfo, null, 2)
  );
}

deploy().catch(console.error);