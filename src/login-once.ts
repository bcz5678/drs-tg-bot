// login-once.ts — run over SSH one time, then never again
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import readline from "node:readline/promises";

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const client = new TelegramClient(new StringSession(""), Number(process.env.TG_API_ID), process.env.TG_API_HASH!, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => rl.question("Phone: "),
    phoneCode:   () => rl.question("Code: "),     // arrives in your Telegram app
    password:    () => rl.question("2FA password: "),
    onError: console.error,
  });

  console.log("TG_SESSION=", client.session.save());  // copy into .env, then delete this file's output
  await client.disconnect();
}

main();