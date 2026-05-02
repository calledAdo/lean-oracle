export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
}

export const testnet: NetworkConfig = {
  name: "testnet",
};
