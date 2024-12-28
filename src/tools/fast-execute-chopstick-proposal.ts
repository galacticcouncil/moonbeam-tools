// This script is expected to run against a parachain network (using launch.ts script)
import { ApiPromise, Keyring } from "@polkadot/api";
import { GenericExtrinsic } from '@polkadot/types';
import { FrameSupportPreimagesBounded } from "@polkadot/types/lookup";
import { blake2AsHex } from "@polkadot/util-crypto";
import chalk from "chalk";
import yargs from "yargs";

import { ALITH_PRIVATE_KEY, getApiFor, NETWORK_YARGS_OPTIONS } from "../index.ts";
import { hexToU8a } from "@polkadot/util";

const debug = require("debug")("fast-executor");
const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "proposal-index": {
      type: "number",
      description: "Proposal index",
    },
    "encoded-proposal": {
      type: "string",
      description: "Encoded proposal",
    },
  }).argv;

async function moveScheduledCallTo(
  api: ApiPromise,
  blockCounts: number,
  verifier: (call: FrameSupportPreimagesBounded) => boolean,
) {
  const blockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  // Fast forward the nudge referendum to the next block to get the refendum to be scheduled
  const agenda = await api.query.scheduler.agenda.entries();
  let found = false;
  for (const agendaEntry of agenda) {
    for (const scheduledEntry of agendaEntry[1]) {
      if (scheduledEntry.isSome && verifier(scheduledEntry.unwrap().call)) {
        found = true;
        console.log(`${chalk.blue("SetStorage")} scheduler.agenda`);
        const result = await api.rpc("dev_setStorage", [
          [agendaEntry[0]], // require to ensure unique id
          [await api.query.scheduler.agenda.key(blockNumber + blockCounts), agendaEntry[1].toHex()],
        ]);
        if (scheduledEntry.unwrap().maybeId.isSome) {
          const id = scheduledEntry.unwrap().maybeId.unwrap().toHex();
          const lookup = await api.query.scheduler.lookup(id);
          debug(
            `Checking lookup ${scheduledEntry.unwrap().maybeId.unwrap().toHex()}: ${lookup.isSome}`,
          );
          if (lookup.isSome) {
            const lookupKey = await api.query.scheduler.lookup.key(id);
            const lookupJson = lookup.unwrap().toJSON();
            const fastLookup = api.registry.createType("Option<(u32,u32)>", [
              blockNumber + blockCounts,
              0,
            ]);
            const result = await api.rpc("dev_setStorage", [[lookupKey, fastLookup.toHex()]]);
            debug(`Updated lookup to ${fastLookup.toJSON()}`);
          }
        }
      }
    }
  }
  if (!found) {
    throw new Error("No scheduled call found");
  }
}

const generateProposal = async (api: ApiPromise, proposalIndex: number, encodedProposal: string = null) => {
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  const preimage = api.tx(api.registry.createType('Call', encodedProposal));

  await new Promise<void>(async (resolve, reject) => {
    const unsub = await api.tx.utility
      .batchAll([
        api.tx.preimage.notePreimage(preimage.method.toHex()),
        api.tx.referenda.submit(
          {
            System: "Root",
          } as any,
          { Lookup: { Hash: preimage.method.hash.toHex(), len: preimage.method.encodedLength } },
          { At: 0 },
        ),
      ])
      .signAndSend(alice, (status: any) => {
        if (status.blockNumber) {
          unsub();
          const error = status.dispatchError?.toString();
          if (error) {
            reject(new Error("failed to submit referenda: " + error));
          } else {
            resolve();
          }
        }
      });
  });
};

const main = async () => {
  if (argv["encoded-proposal"] && "proposal-index" in argv) {
    console.log("--encoded-proposal not compatible with --proposal-index");
    return;
  }
  if (!argv["encoded-proposal"] && !("proposal-index" in argv)) {
    console.log("Missing --encoded-proposal or --proposal-index");
    return;
  }

  // Instantiate Api
  const api = await getApiFor(argv);
  const totalIssuance = (await api.query.balances.totalIssuance()).toBigInt();
  const proposalIndex = argv["encoded-proposal"]
    ? (await api.query.referenda.referendumCount()).toNumber()
    : argv["proposal-index"];

  console.log(
    `[#${chalk.green((await api.rpc.chain.getHeader()).number.toNumber())}]: Referedum ${chalk.red(
      proposalIndex,
    )}`,
  );

  if (argv["encoded-proposal"]) {
    await generateProposal(api, proposalIndex, argv["encoded-proposal"]);
  }

  const referendumData = await api.query.referenda.referendumInfoFor(proposalIndex);
  const referendumKey = api.query.referenda.referendumInfoFor.key(proposalIndex);
  if (!referendumData.isSome) {
    throw new Error(`Referendum ${proposalIndex} not found`);
  }
  const referendumInfo = referendumData.unwrap();
  if (!referendumInfo.isOngoing) {
    throw new Error(`Referendum ${proposalIndex} is not ongoing`);
  }

  const ongoingData = referendumInfo.asOngoing;
  const ongoingJson = ongoingData.toJSON();
  // Support Lookup, Inline or Legacy
  const callHash = ongoingData.proposal.isLookup
    ? ongoingData.proposal.asLookup.toHex()
    : ongoingData.proposal.isInline
      ? blake2AsHex(ongoingData.proposal.asInline.toHex())
      : ongoingData.proposal.asLegacy.toHex();

  const proposalBlockTarget = (await api.rpc.chain.getHeader()).number.toNumber();
  const fastProposalData = {
    ongoing: {
      ...ongoingJson,
      enactment: { after: 0 },
      deciding: {
        since: proposalBlockTarget - 1,
        confirming: proposalBlockTarget - 1,
      },
      tally: {
        ayes: totalIssuance - 1n,
        nays: 0,
        support: totalIssuance - 1n,
      },
      alarm: [proposalBlockTarget + 1, [proposalBlockTarget + 1, 0]],
    },
  };

  let fastProposal;
  try {
    fastProposal = api.registry.createType(
      `Option<PalletReferendaReferendumInfo>`,
      fastProposalData,
    );
  } catch {
    fastProposal = api.registry.createType(
      `Option<PalletReferendaReferendumInfoConvictionVotingTally>`,
      fastProposalData,
    );
  }

  console.log(
    `${chalk.blue("SetStorage")} Fast Proposal: ${chalk.red(
      proposalIndex.toString(),
    )} referendumKey ${referendumKey}`,
  );
  const result = await api.rpc("dev_setStorage", [[referendumKey, fastProposal.toHex()]]);

  // Fast forward the nudge referendum to the next block to get the refendum to be scheduled
  console.log(
    `${chalk.yellow("Rescheduling")} ${chalk.red("scheduler.nudgeReferendum")} to #${chalk.green(
      (await api.rpc.chain.getHeader()).number.toNumber() + 2,
    )}`,
  );
  await moveScheduledCallTo(api, 1, (call) => {
    if (!call.isInline) {
      return false;
    }
    const callData = api.createType("Call", call.asInline.toHex());
    return (
      callData.method == "nudgeReferendum" && (callData.args[0] as any).toNumber() == proposalIndex
    );
  });

  console.log(
    `${chalk.yellow("Fast forward")} ${chalk.green(1)} to #${chalk.green(
      (await api.rpc.chain.getHeader()).number.toNumber() + 1,
    )}`,
  );
  await api.rpc("dev_newBlock", { count: 1 });

  // Fast forward the scheduled proposal
  console.log(
    `${chalk.yellow("Rescheduling")} proposal ${chalk.red(proposalIndex)} to #${chalk.green(
      (await api.rpc.chain.getHeader()).number.toNumber() + 2,
    )}`,
  );
  await moveScheduledCallTo(api, 1, (call) =>
    call.isLookup
      ? call.asLookup.toHex() == callHash
      : call.isInline
        ? blake2AsHex(call.asInline.toHex()) == callHash
        : call.asLegacy.toHex() == callHash,
  );

  console.log(
    `${chalk.yellow("Fast forward")} ${chalk.green(1)} to #${chalk.green(
      (await api.rpc.chain.getHeader()).number.toNumber() + 1,
    )}`,
  );
  await api.rpc("dev_newBlock", { count: 1 });
  await api.disconnect();
  process.exit(0);
};

process.on("unhandledRejection", (reason, p) => {
  console.error("Unhandled Rejection at:", p, "reason:", reason);
  process.exit(1);
});

try {
  main();
} catch (e) {
  console.log(e);
  process.exit(1);
}
