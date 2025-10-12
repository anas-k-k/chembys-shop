const { test, expect } = require("@playwright/test");
const { LoginPage } = require("./pages/loginPage");

test("navigate to chembys.shop/login and type credentials using page object", async ({
  page,
}) => {
  const login = new LoginPage(page);
  await login.goto();
  await expect(page).toHaveURL(/.*\/login/);

  const username = "anas";
  const password = "anas@123";

  await login.fillUsername(username, { delay: 120 });
  await login.fillPassword(password, { delay: 120 });
  await login.submit();
});
