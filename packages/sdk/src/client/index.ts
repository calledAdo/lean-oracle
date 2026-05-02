import type { NetworkConfig } from "../networks/index.js";

export interface LeanOracleClientOptions {
  network: NetworkConfig;
}

export class LeanOracleClient {
  readonly network: NetworkConfig;

  constructor(options: LeanOracleClientOptions) {
    this.network = options.network;
  }
}
