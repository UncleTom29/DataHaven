import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/",
      accounts: [process.env.DEPLOYER_PRIVATE_KEY || ""
      ],
    },
    mainnet: {
      url: process.env.ETHEREUM_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/",
      accounts: [process.env.DEPLOYER_PRIVATE_KEY || ""],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || ""
  },
};

export default config;