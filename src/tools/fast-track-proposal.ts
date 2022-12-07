/*
  Performs a runtime upgrade through sudo or council (requires polkadot v0.9.32+)

Ex: ./node_modules/.bin/ts-node-transpile-only src/tools/upgrade-network.ts \
   --url ws://localhost:9944 \
   --send-proposal-as council-external \
   --collective-threshold 3 \
   --proxy <council-account> \
   --account-priv-key <key> \
*/
import yargs from "yargs";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import {
  monitorSubmittedExtrinsic,
  waitForAllMonitoredExtrinsics,
} from "../utils/monitoring";
import { maybeProxyCall } from "../utils/transactions";
import { ALITH_PRIVATE_KEY } from "../utils/constants";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": {
      type: "string",
      demandOption: false,
      alias: "account",
    },
    proxy: {
      type: "string",
      demandOption: false,
      describe: "Account being proxied",
      conflicts: ["sudo"],
    },
    "proxy-type": {
      type: "string",
      demandOption: false,
      describe: "Type of proxy",
    },
    alith: {
      type: "boolean",
      demandOption: false,
      conflicts: ["account-priv-key"],
    },
    proposal: {
      type: "string",
      demandOption: true,
      describe: "hash of the proposal",
    },
    voting: { type: "number", demandOption: true, describe: "number of block for voting period" },
    enactment: {
      type: "number",
      demandOption: true,
      describe: "number of block for enactment period",
    },
    "collective-threshold": { type: "number", demandOption: true, alias: "c" },
  })
  .check((argv) => {
    if (!(argv["account-priv-key"] || argv["alith"])) {
      throw new Error("Missing --account-priv-key or --alith");
    }
    return true;
  }).argv;

async function main() {
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  try {
    const collectiveThreshold =
      argv["collective-threshold"] ||
      Math.ceil(((await api.query.councilCollective.members()).length * 3) / 5);

    let account: KeyringPair;
    let nonce;
    const privKey = argv["alith"] ? ALITH_PRIVATE_KEY : argv["account-priv-key"];
    if (privKey) {
      account = keyring.addFromUri(privKey, null, "ethereum");
      const { nonce: rawNonce, data: balance } = (await api.query.system.account(
        account.address
      )) as any;
      nonce = BigInt(rawNonce.toString());
    }

    const tryProxy = (call) => {
      return maybeProxyCall(api, call, argv["proxy"], argv["proxy-type"]);
    };

    const fastrack = api.tx.democracy.fastTrack(
      argv["proposal"],
      argv["voting"],
      argv["enactment"]
    );
    await tryProxy(
      api.tx.techCommitteeCollective.propose(collectiveThreshold, fastrack, fastrack.length)
    ).signAndSend(
      account,
      { nonce: nonce++ },
      monitorSubmittedExtrinsic(api, { id: "fast-track" })
    );
  } finally {
    await waitForAllMonitoredExtrinsics();
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
