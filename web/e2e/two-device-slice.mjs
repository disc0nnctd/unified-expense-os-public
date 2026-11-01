// End-to-end MVP vertical slice against the running compose stack:
// onboard device A -> create context -> invite -> device B joins -> shared
// expense syncs A->B -> B records settlement -> offline capture on A queues
// and drains when back online -> recurring template generates rent.
//
// Run: node e2e/two-device-slice.mjs [baseUrl]
import { chromium } from "playwright";

const BASE_URL = process.argv[2] ?? "http://localhost:4173/";
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp";
let step = 0;

function log(message) {
  step += 1;
  console.log(`[${step}] ${message}`);
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  // --- Device A: onboard and create the household -------------------------
  const deviceA = await browser.newContext();
  const pageA = await deviceA.newPage();
  await pageA.goto(BASE_URL);
  await pageA.getByPlaceholder("e.g. Alice").fill("Asha");
  await pageA.getByRole("button", { name: "Create my identity" }).click();
  await pageA.getByRole("button", { name: "Skip for now" }).click();
  await pageA.getByRole("heading", { name: "Contexts" }).waitFor();
  log("device A onboarded as Asha");

  await pageA.getByPlaceholder("e.g. Home 2026").fill("Home 2026");
  await pageA.getByRole("button", { name: "Create context" }).click();
  await pageA.getByRole("heading", { name: "Home 2026", level: 1 }).waitFor();
  log("device A created shared context Home 2026");

  // Context screen sections are tabbed at every viewport width (0fj) —
  // invite generation lives under "People".
  await pageA.getByRole("tab", { name: "People" }).click();
  await pageA.getByRole("button", { name: "New invite code" }).click();
  const inviteCode = (await pageA.locator(".invite-code").first().textContent()).trim();
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(inviteCode)) {
    throw new Error(`Unexpected invite code format: ${inviteCode}`);
  }
  log(`device A generated invite ${inviteCode}`);

  // --- Device B: join via invite -------------------------------------------
  const deviceB = await browser.newContext();
  const pageB = await deviceB.newPage();
  await pageB.goto(BASE_URL);
  await pageB.getByPlaceholder("e.g. Bob").fill("Ravi");
  await pageB.getByPlaceholder("XXXX-XXXX").fill(inviteCode.toLowerCase());
  await pageB.getByRole("button", { name: "Join with code" }).click();
  await pageB.getByRole("heading", { name: "Contexts" }).waitFor();
  await pageB.getByRole("button", { name: /Home 2026/ }).waitFor();
  log("device B joined with the invite code (entered lowercase)");

  // --- Device A: sync to learn about Ravi, then record a shared expense ----
  await pageA.getByRole("button", { name: "← All contexts" }).click();
  await pageA.getByRole("button", { name: "Sync", exact: true }).click();
  await pageA.getByRole("button", { name: /Home 2026/ }).click();
  await pageA.getByRole("tab", { name: "People" }).click();
  await pageA.locator(".preference-list").getByText("Ravi").waitFor();
  log("device A sees Ravi as an active member after sync");

  await pageA.getByRole("tab", { name: "Expenses" }).click();
  await pageA.getByPlaceholder("e.g. Groceries").fill("Groceries");
  await pageA.getByPlaceholder("450.50").fill("450.50");
  await pageA.getByRole("button", { name: "Save expense" }).click();
  await pageA.locator(".entry-list").getByText("Groceries").waitFor();
  await pageA
    .locator(".entry-list .pending-badge")
    .waitFor({ state: "detached", timeout: 15000 });
  log("device A recorded ₹450.50 Groceries and it synced (queued badge cleared)");

  // --- Device B: pull, verify balances, settle up ---------------------------
  await pageB.getByRole("button", { name: /Home 2026/ }).click();
  await pageB.getByRole("button", { name: "Sync", exact: true }).click();
  await pageB.locator(".entry-list").getByText("Groceries").waitFor();
  await pageB.getByRole("tab", { name: "Balances" }).click();
  const balances = await pageB.locator(".balance-list").first().textContent();
  if (!balances.includes("225.25")) {
    throw new Error(`Expected a ±225.25 split in balances, got: ${balances}`);
  }
  log("device B pulled the expense; balances show the ±₹225.25 split");

  await pageB.getByRole("button", { name: "Record", exact: true }).click();
  await pageB.getByText("All settled").waitFor({ timeout: 15000 });
  log("device B recorded the recommended settlement; context is settled");

  // --- Device A: offline capture queues, reconnect drains -------------------
  await deviceA.setOffline(true);
  await pageA.getByText("Offline", { exact: true }).waitFor();
  await pageA.getByPlaceholder("e.g. Groceries").fill("Chai");
  await pageA.getByPlaceholder("450.50").fill("20");
  await pageA.getByRole("button", { name: "Save expense" }).click();
  await pageA.locator(".entry-list .pending-badge").waitFor();
  log("device A captured Chai ₹20 while offline; entry shows queued");

  await deviceA.setOffline(false);
  await pageA
    .locator(".entry-list .pending-badge")
    .waitFor({ state: "detached", timeout: 15000 });
  log("device A back online; queued entry drained to the server");

  // --- Device A: recurring obligation ---------------------------------------
  await pageA.getByPlaceholder("Rent").fill("Rent");
  await pageA.getByPlaceholder("30000").fill("30000");
  await pageA.getByRole("button", { name: "Add recurring" }).click();
  await pageA.locator(".entry-list").getByText("Rent", { exact: true }).waitFor();
  await pageA.getByRole("button", { name: "Generate due" }).click();
  await pageA.locator(".entry-list").getByText("Rent").nth(1).waitFor({ timeout: 15000 });
  log("device A added a Rent template and generated this month's entry");

  await pageA.screenshot({ path: `${SHOT_DIR}/e2e-device-a-context.png`, fullPage: true });
  await pageB.getByRole("button", { name: "Sync", exact: true }).click();
  await pageB.getByRole("tab", { name: "Expenses" }).click();
  await pageB.locator(".entry-list").getByText("Rent").first().waitFor({ timeout: 15000 });
  await pageB.getByRole("button", { name: "← All contexts" }).click();
  await pageB.getByText("My share this month").waitFor();
  await pageB.screenshot({ path: `${SHOT_DIR}/e2e-device-b-home.png`, fullPage: true });
  log("device B pulled the generated rent entry; dashboard renders");

  console.log("\nE2E vertical slice PASSED");
} finally {
  await browser.close();
}
