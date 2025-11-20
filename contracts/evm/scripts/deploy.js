const { ethers, run } = require("hardhat");

async function main() {
  console.log("Deploying DataHaven Ethereum Contract...");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // Get relayer address from environment or use deployer
  const relayerAddress = process.env.RELAYER_ADDRESS || deployer.address;

  const DataHaven = await ethers.getContractFactory("DataHaven");
  const datahaven = await DataHaven.deploy(relayerAddress);
  await datahaven.waitForDeployment();

  const address = await datahaven.getAddress();
  console.log("✅ DataHaven deployed to:", address);
  console.log("Relayer:", relayerAddress);

  // Save deployment info
  const fs = require('fs');
  const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    contract: address,
    relayer: relayerAddress,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };
  
  fs.writeFileSync(
    'deployment-ethereum.json',
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("✅ Deployment info saved to deployment-ethereum.json");

  console.log("\n=== Verifying  Contract ===");
  console.log(`npx hardhat verify --network sepolia ${address} ${relayerAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });