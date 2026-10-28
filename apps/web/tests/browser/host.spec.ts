import { expect, test } from "@playwright/test";

test("production host shows the empty viewer without browser startup errors", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(`Page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`Console error: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    errors.push(`Request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });

  const response = await page.goto("./", { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Adobo Acrobatics");
  await expect(
    page.getByRole("heading", { level: 1, name: "Adobo Acrobatics" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Your document will appear here" }),
  ).toContainText("PDF viewing is coming next.");
  expect(errors).toEqual([]);
});
