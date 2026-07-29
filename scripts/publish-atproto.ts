import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { Client } from "@atproto/lex";
import {
  buildAtprotoLoopbackClientMetadata,
  NodeOAuthClient,
  requestLocalLock,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthSession,
} from "@atproto/oauth-client-node";

import {
  ATPROTO_CREATE_SCOPE,
  deterministicRecordKey,
  LINKED_CLAIMS_COLLECTION,
  publicationReceipt,
  publishClaim,
  readExistingReceipt,
  readPublicationEnvelope,
  toLinkedClaim,
  writeReceipt,
  type ClaimPublisher,
} from "../src/atproto-publisher.ts";
import {
  main as linkedClaim,
  type Main as LinkedClaim,
} from "../src/lexicons/com/linkedclaims/claim.defs.ts";

const CALLBACK_PATH = "/atproto-oauth-callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const RECORD_SCOPE = "repo:com.linkedclaims.claim?action=create";

interface Arguments {
  envelope: string;
  publish: boolean;
  handle: string | null;
  receipt: string | null;
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  if (!args.envelope) return;
  const envelope = await readPublicationEnvelope(args.envelope);
  const record = toLinkedClaim(envelope);
  const rkey = deterministicRecordKey(envelope);

  if (!args.publish) {
    printJson({
      mode: "dry-run",
      mutationAttempted: false,
      collection: LINKED_CLAIMS_COLLECTION,
      rkey,
      requestedScope: ATPROTO_CREATE_SCOPE,
      envelopeSha256: envelope.envelopeSha256,
      record: linkedClaim.build(record),
    });
    return;
  }

  if (!args.handle || !args.receipt) {
    throw new Error(
      "Live publication requires both --handle and --receipt in addition to --publish.",
    );
  }

  const existingReceipt = await readExistingReceipt(args.receipt, envelope);
  if (existingReceipt) {
    printJson({
      mode: "already-published",
      mutationAttempted: false,
      receipt: existingReceipt,
    });
    return;
  }

  const session = await authorize(args.handle);
  const tokenInfo = await session.getTokenInfo();
  const scopes = new Set(tokenInfo.scope.split(/\s+/));
  if (!scopes.has("atproto") || !scopes.has(RECORD_SCOPE)) {
    throw new Error(
      `OAuth token did not grant the required ${RECORD_SCOPE} permission.`,
    );
  }

  const client = new Client(session, { validateRequest: true });
  const publisher = clientPublisher(client, session.did);
  const result = await publishClaim(publisher, envelope);
  const receipt = publicationReceipt(envelope, result);
  const receiptState = await writeReceipt(args.receipt, receipt);
  printJson({
    mode: "published",
    mutationAttempted: true,
    recordReused: result.reused,
    receiptState,
    receipt,
  });
}

async function authorize(handle: string): Promise<OAuthSession> {
  const state = new Map<string, NodeSavedState>();
  const sessions = new Map<string, NodeSavedSession>();
  const clientRef: { current?: NodeOAuthClient } = {};
  let resolveCallback: (session: OAuthSession) => void;
  let rejectCallback: (error: Error) => void;
  const callback = new Promise<OAuthSession>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found\n");
        return;
      }
      if (!clientRef.current) throw new Error("OAuth client is not ready.");
      const result = await clientRef.current.callback(url.searchParams);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "AT Protocol authorization completed. You can close this tab.\n",
      );
      resolveCallback(result.session);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("AT Protocol authorization failed.\n");
      rejectCallback(asError(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate the loopback OAuth callback port.");
  }
  const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  const client = new NodeOAuthClient({
    clientMetadata: buildAtprotoLoopbackClientMetadata({
      scope: ATPROTO_CREATE_SCOPE,
      redirect_uris: [redirectUri],
    }),
    stateStore: {
      async set(key, value) {
        state.set(key, value);
      },
      async get(key) {
        return state.get(key);
      },
      async del(key) {
        state.delete(key);
      },
    },
    sessionStore: {
      async set(key, value) {
        sessions.set(key, value);
      },
      async get(key) {
        return sessions.get(key);
      },
      async del(key) {
        sessions.delete(key);
      },
    },
    requestLock: requestLocalLock,
  });
  clientRef.current = client;

  const authorizationUrl = await client.authorize(handle, {
    state: randomUUID(),
  });
  process.stderr.write(
    `Authorize this one publication in your browser:\n${authorizationUrl}\n`,
  );

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      callback,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("AT Protocol OAuth callback timed out.")),
          CALLBACK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function clientPublisher(client: Client, did: string): ClaimPublisher {
  return {
    did,
    async create(record, rkey) {
      return client.create(linkedClaim, record, { rkey, validate: true });
    },
    async get(rkey) {
      const existing = await client.get(linkedClaim, { rkey });
      if (!existing.cid) {
        throw new Error("Existing AT Protocol record response has no CID.");
      }
      return {
        uri: existing.uri,
        cid: existing.cid,
        value: existing.value as LinkedClaim,
      };
    },
  };
}

function parseArguments(argv: string[]): Arguments {
  if (!argv.length || argv.includes("--help")) {
    process.stdout.write(
      "Usage: npm run publish:atproto -- <envelope.json> [--publish --handle <handle> --receipt <receipt.json>]\n\nWithout --publish, validates and prints the proposed LinkedClaims record without OAuth or network mutation.\n",
    );
    if (!argv.length) throw new Error("A publication envelope is required.");
    process.exitCode = 0;
    return {
      envelope: "",
      publish: false,
      handle: null,
      receipt: null,
    };
  }
  const envelope = argv[0];
  let publish = false;
  let handle: string | null = null;
  let receipt: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--publish") {
      publish = true;
    } else if (argument === "--handle" || argument === "--receipt") {
      const value = argv.at(index + 1);
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      if (argument === "--handle") handle = value;
      else receipt = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { envelope, publish, handle, receipt };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error) => {
    process.stderr.write(`${asError(error).message}\n`);
    process.exitCode = 1;
  });
}
