import { replayRecording } from "../src/dgt/recording.ts";

const path = process.argv[2];
if (!path) throw new Error("Usage : npm run dgt:replay -- chemin/session.jsonl");
const replay = await replayRecording(path);
for (const message of replay.messages) console.log(JSON.stringify(message));
for (const error of replay.errors) console.error(error);
console.error(`${replay.messages.length} messages, ${replay.errors.length} erreurs`);
if (replay.errors.length) process.exitCode = 1;
