// Small programs written to the app's data folder and run with the app's own runtime, so a new computer needs no Node.
// A secret reaches them through their environment, set for that one command, and never through their arguments.

// Answers OpenSSH and git when they ask for a password. A question about trusting a server gets no answer, so
// an unknown server is refused rather than trusted on the agent's behalf.
export const ASKPASS_JS = `const prompt = process.argv[2] || "";
if (/yes\\/no|fingerprint|continue connecting/i.test(prompt)) process.exit(1);
if (/username/i.test(prompt)) {
  if (!process.env.DESK_ASKPASS_USER) process.exit(1);
  process.stdout.write(process.env.DESK_ASKPASS_USER + "\\n");
} else {
  process.stdout.write((process.env.DESK_ASKPASS_SECRET || "") + "\\n");
}
`;

// Logs in over telnet and runs commands. Windows has no telnet client by default, and one could not be scripted anyway.
export const TELNET_JS = `const net = require("node:net");
const args = process.argv.slice(2);
const runs = [];
let host = "";
let port = 23;
let limit = 60;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--run") runs.push(args[++i] ?? "");
  else if (args[i] === "--timeout") limit = Number(args[++i]) || limit;
  else if (!host) host = args[i];
  else port = Number(args[i]) || port;
}
if (!host) {
  console.error("Usage: desk-telnet NAME host [port] --run \\"command\\" [--run \\"command\\"] [--timeout seconds]");
  process.exit(2);
}
const user = process.env.DESK_TELNET_USER || "";
const secret = process.env.DESK_TELNET_SECRET || "";
console.error("Note: telnet is not encrypted. This password crossed the network in the clear.");
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240, ECHO = 1, SGA = 3;
const sock = net.connect({ host, port });
let tail = "";
let sentUser = !user;
let sentPass = false;
let ready = false;
let idle = null;
let done = false;
const finish = (code, message) => {
  if (done) return;
  done = true;
  if (message) console.error(message);
  sock.destroy();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 50);
};
setTimeout(() => finish(1, "Timed out after " + limit + " seconds."), limit * 1000);
const quiet = (ms, then) => {
  clearTimeout(idle);
  idle = setTimeout(then, ms);
};
const next = () => {
  if (!runs.length) return finish(0);
  tail = "";
  sock.write(runs.shift() + "\\r\\n");
  quiet(1500, next);
};
const look = () => {
  const text = tail.replace(/\\u001b\\[[0-9;?]*[A-Za-z]/g, "");
  if (sentPass && /login incorrect|incorrect password|authentication failed|access denied|bad password|login invalid|% ?login/i.test(text)) {
    return finish(1, "The device refused this login.");
  }
  if (!sentUser && /(login|user ?name|user)\\s*:?\\s*$/i.test(text)) {
    sentUser = true;
    tail = "";
    sock.write(user + "\\r\\n");
  } else if (!sentPass && /pass(word|code)?\\s*:?\\s*$/i.test(text)) {
    sentPass = true;
    tail = "";
    sock.write(secret + "\\r\\n");
    ready = true;
  }
  if (ready) quiet(1500, next);
  else quiet(10000, () => finish(1, "No login prompt was recognized. Last text: " + text.slice(-200)));
};
sock.on("data", (data) => {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== IAC) {
      out.push(data[i]);
      continue;
    }
    const verb = data[++i];
    const option = data[i + 1];
    if (verb === IAC) out.push(IAC);
    else if (verb === SB) {
      while (i < data.length && !(data[i] === IAC && data[i + 1] === SE)) i++;
      i++;
    } else if (verb === WILL || verb === WONT) {
      sock.write(Buffer.from([IAC, verb === WILL && (option === ECHO || option === SGA) ? DO : DONT, option]));
      i++;
    } else if (verb === DO || verb === DONT) {
      sock.write(Buffer.from([IAC, verb === DO && option === SGA ? WILL : WONT, option]));
      i++;
    }
  }
  let text = Buffer.from(out).toString("utf8");
  if (secret) text = text.split(secret).join("[hidden]");
  process.stdout.write(text);
  tail = (tail + text).slice(-400);
  look();
});
sock.on("error", (err) => finish(1, "Could not connect: " + err.message));
sock.on("close", () => finish(ready ? 0 : 1, ready ? "" : "The connection closed before login finished."));
`;
