// CLI: create or update an operator account.
//   docker compose exec app node dist/create-operator.js <email> <display name> [role]
// The password is read from the OPERATOR_PASSWORD environment variable (or, with
// a terminal, prompted for) so it never lands in shell history or `ps` output.
import { createInterface } from "node:readline/promises";
import { upsertOperator, MIN_PASSWORD_LENGTH } from "./auth.js";
import { runMigrations } from "./migrate.js";
import { pool } from "./db.js";

async function main(): Promise<void> {
  const [email, displayName, role = "operator"] = process.argv.slice(2);
  if (!email || !displayName || !["operator", "admin"].includes(role)) {
    console.error("usage: create-operator <email> <display name> [operator|admin]   (password: OPERATOR_PASSWORD)");
    process.exit(2);
  }
  let password = process.env.OPERATOR_PASSWORD ?? "";
  if (!password && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question(`Password (min ${MIN_PASSWORD_LENGTH} chars; input is visible): `);
    rl.close();
  }
  if (!password) {
    console.error("set OPERATOR_PASSWORD or run with a terminal");
    process.exit(2);
  }
  await runMigrations();
  const op = await upsertOperator(email, displayName, password, role);
  console.log(`operator ready: ${op.email} (${op.role})`);
  await pool.end();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
