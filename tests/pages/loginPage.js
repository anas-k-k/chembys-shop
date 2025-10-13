class LoginPage {
  /**
   * @param {import('@playwright/test').Page} page
   */
  constructor(page) {
    this.page = page;
    // default selectors - can be extended
    this.usernameSelectors = [
      'input[name="username"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[type="text"]',
    ];
    this.passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
    ];
    this.submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'input[type="submit"]',
    ];
  }

  async goto() {
    await this.page.goto("https://chembys.shop/login");
    await this.page.waitForLoadState("networkidle");
  }

  async _findVisible(selectors) {
    for (const sel of selectors) {
      const el = await this.page.$(sel);
      if (el) {
        try {
          if (await el.isVisible()) return sel;
        } catch (e) {
          // ignore and continue
        }
      }
    }
    return null;
  }

  async fillUsername(username, options = { delay: 120 }) {
    const sel = await this._findVisible(this.usernameSelectors);
    if (!sel) throw new Error("Username field not found");
    await this.page.click(sel);
    await this.page.type(sel, username, options);
    return sel;
  }

  async fillPassword(password, options = { delay: 120 }) {
    const sel = await this._findVisible(this.passwordSelectors);
    if (!sel) throw new Error("Password field not found");
    await this.page.click(sel);
    await this.page.type(sel, password, options);
    return sel;
  }

  async submit() {
    const sel = await this._findVisible(this.submitSelectors);
    if (sel) {
      await this.page.click(sel);
    } else {
      // fallback: press Enter in password field if available
      const passSel = await this._findVisible(this.passwordSelectors);
      if (passSel) await this.page.press(passSel, "Enter");
    }
  }

  // Navigate the left sidebar and open Orders > Order List
  async selectOrderList() {
    // Wait for the sidebar menu to be present on the master page
    await this.page.waitForSelector("ul.sidebar-menu", {
      state: "visible",
      timeout: 10000,
    });

    // Try to expand the "Orders" treeview by clicking its anchor
    const ordersAnchor = await this.page.$(
      'ul.sidebar-menu a:has-text("Orders")'
    );
    if (ordersAnchor) {
      try {
        await ordersAnchor.click();
      } catch (e) {
        // ignore click errors and continue to find the link
      }
    }

    // Click the Order List link. Try common href and text-based selectors.
    const orderListSelector =
      'a[href="https://chembys.shop/inventory/order_list"], a[href="/inventory/order_list"], ul.treeview-menu a:has-text("Order List")';
    await this.page.waitForSelector(orderListSelector, {
      state: "visible",
      timeout: 10000,
    });
    await this.page.click(orderListSelector);

    // Wait for navigation or the page to load
    try {
      await this.page.waitForLoadState("networkidle");
    } catch (e) {
      // ignore load state timeout
    }
  }
}

module.exports = { LoginPage };
