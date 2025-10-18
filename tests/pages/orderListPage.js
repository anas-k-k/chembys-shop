const path = require("path");
const fs = require("fs");
let xlsx;
try {
  xlsx = require("xlsx");
} catch (e) {
  // If xlsx isn't installed, we'll fail later when attempting to read files.
  xlsx = null;
}

// List of order IDs to skip during processing. Keep this as a central list
// so it's easy to add more orders later without changing loop logic.
// Order IDs are stored as strings for consistent comparison.
const SKIPPED_ORDERS = new Set([""]);

// Extract pincode(s) from a raw text blob.
// Returns an array of numeric pincodes as strings (e.g. ['689672']).
// Matches formats like 'Pincode : 689672', 'Pincode:689672', or plain 6-digit numbers.
function extractPincode(rawText) {
  if (!rawText || typeof rawText !== "string") return [];

  // normalize and search for 6-digit sequences which are typical pincodes
  const candidates = [];

  // First try to find patterns like 'Pincode *: *123456'
  const labelled = rawText.match(/Pincode\s*[:\-]?\s*(\d{4,6})/gi);
  if (labelled) {
    for (const m of labelled) {
      const num = m.match(/(\d{4,6})/);
      if (num) candidates.push(num[1]);
    }
  }

  // Fallback: find any 4-6 digit sequences (some pincodes may be 4-6 digits depending on locale)
  if (!candidates.length) {
    const any = rawText.match(/\b\d{4,6}\b/g);
    if (any) candidates.push(...any);
  }

  // dedupe while keeping order
  return [...new Set(candidates)];
}

// Read first-column values from the first sheet of an Excel file and return a Set of strings
function readPincodesFromExcel(absPath) {
  if (!xlsx) return new Set();
  try {
    if (!fs.existsSync(absPath)) return new Set();
    const wb = xlsx.readFile(absPath);
    const sheetName = wb.SheetNames && wb.SheetNames[0];
    if (!sheetName) return new Set();
    const sheet = wb.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    const set = new Set();
    for (const r of rows) {
      if (!r || r.length === 0) continue;
      const v = String(r[0]).trim();
      if (v) set.add(v);
    }
    return set;
  } catch (e) {
    return new Set();
  }
}

// Cache for Excel lookups to avoid re-reading files repeatedly
const _excelCache = {
  DTDC: null, // Set or null
  Delhivery: null,
  lastLoaded: 0,
  // reload interval in ms (optional) - set to 60s to allow occasional refresh
  reloadInterval: 60 * 1000,
};

function loadExcelCaches() {
  const now = Date.now();
  if (
    _excelCache.lastLoaded &&
    now - _excelCache.lastLoaded < _excelCache.reloadInterval &&
    _excelCache.DTDC !== null &&
    _excelCache.Delhivery !== null
  ) {
    return;
  }
  const dataDir = path.join(process.cwd(), "data");
  _excelCache.DTDC = readPincodesFromExcel(path.join(dataDir, "DTDC.xlsx"));
  _excelCache.Delhivery = readPincodesFromExcel(
    path.join(dataDir, "Delhivery.xlsx")
  );
  _excelCache.lastLoaded = now;
}

// runtime base URL (strip trailing slash)
const BASE_URL = (process.env.BASE_URL || "https://chembys.shop").replace(
  /\/$/,
  ""
);

class OrderListPage {
  /**
   * @param {import('@playwright/test').Page} page
   */
  constructor(page) {
    this.page = page;
    // table and button selectors
    this.tableSelector = "table#example";
    // the per-row button as provided in the user request for first row
    // generalize to any row by using tbody tr td button with the same classes
    this.rowButtonSelector = "td.sorting_1 > button.address-show-btn";
    // common popup/modal close selectors to try
    this.popupCloseSelectors = [
      "#addressShowModal > div > div > div.modal-footer > button",
      ".modal:visible button.close",
      '.modal:visible button:has-text("Close")',
      ".modal:visible .close",
      ".bootbox-close-button",
      ".swal2-close",
      'button[aria-label="Close"]',
      'button:has-text("OK")',
      'button:has-text("Close")',
    ];
  }

  // Lightweight local handler for the address popup. Mirrors the behavior of
  // LoginPage.handleAddressPopup but kept here to avoid cross-file coupling.
  async handleAddressPopup(rowIndex = null, orderId = null) {
    const selector = "#addressShowBody";
    try {
      await this.page.waitForSelector(selector, {
        state: "visible",
        timeout: 1500,
      });
    } catch (e) {
      return { foundAddress: false, pincode: null, rawText: null };
    }

    const el = await this.page.$(selector);
    if (!el) return { foundAddress: false, pincode: null, rawText: null };

    const rawText = (await el.innerText()).trim();
    const hasAddressChar = /[A-Za-z0-9]/.test(rawText);

    // If the raw text is too short, close the popup and skip processing for this row
    const textLength = rawText.length;
    if (textLength < 150) {
      // log which row was skipped and the length
      // eslint-disable-next-line no-console
      console.log(
        `Skipping row ${rowIndex != null ? rowIndex : "?"} (orderId=${
          orderId || "N/A"
        }) - address text too short (${textLength} chars)`
      );

      // attempt to close modal using preferred close button or Escape
      const preferredClose =
        "#addressShowModal > div > div > div.modal-footer > button";
      try {
        const closeBtn = await this.page.$(preferredClose);
        if (closeBtn) {
          await closeBtn.click();
          await this.page.waitForTimeout(150);
        } else {
          await this.page.keyboard.press("Escape");
          await this.page.waitForTimeout(100);
        }
      } catch (e) {
        try {
          await this.page.keyboard.press("Escape");
          await this.page.waitForTimeout(100);
        } catch (ee) {
          // ignored
        }
      }

      return {
        foundAddress: false,
        pincode: null,
        rawText,
        textLength,
        orderId,
      };
    }

    // try to extract pincode(s) from the raw text and log the main one
    const pincodes = extractPincode(rawText);
    const pincode = pincodes.length ? pincodes[0] : null;

    // eslint-disable-next-line no-console
    console.log(
      `Extracted pincode from address popup: ${pincode} (orderId=${
        orderId || "N/A"
      })`
    );

    // First attempt: click the modal footer close button (preferred selector)
    const preferredClose =
      "#addressShowModal > div > div > div.modal-footer > button";
    try {
      const closeBtn = await this.page.$(preferredClose);
      if (closeBtn) {
        await closeBtn.click();
        // give modal a moment to close
        await this.page.waitForTimeout(150);
      } else {
        // fallback to pressing Escape if preferred button not found
        await this.page.keyboard.press("Escape");
        await this.page.waitForTimeout(100);
      }
    } catch (e) {
      // if clicking fails for any reason, fallback to Escape
      try {
        await this.page.keyboard.press("Escape");
        await this.page.waitForTimeout(100);
      } catch (e) {
        // ignored
      }
    }

    return {
      foundAddress: hasAddressChar,
      pincode,
      pincodes,
      rawText,
      orderId,
    };
  }

  // Open a new tab for the order sync page, click Sync with Shiprocket,
  // interact with the modal (select courier DTDC, choose radio, wait), then close.
  // This method is defensive and will return quickly if elements are not found.
  async syncShiprocketForOrder(orderId, { waitMs = 2500 } = {}) {
    if (!orderId) return { synced: false, reason: "no-order-id" };

    const targetUrl = `${BASE_URL}/inventory/order/${orderId}`;
    // open new tab
    const context = this.page.context();
    const newPage = await context.newPage();
    try {
      await newPage.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      // wait for the sync button and click it
      try {
        await newPage.waitForSelector("#sync_shiprocket", {
          state: "visible",
          timeout: 4000,
        });
        await newPage.click("#sync_shiprocket");
      } catch (e) {
        // couldn't find or click sync button
        return { synced: false, reason: "no-sync-button" };
      }

      // Wait for the logistics modal to appear (the selector for the dropdown wrapper)
      const dropdownWrapper =
        "#logisticsModal > div > div > div.modal-body > div > div > div.col-md-9 > div > span > span.selection > span";
      try {
        await newPage.waitForSelector(dropdownWrapper, {
          state: "visible",
          timeout: 5000,
        });
        // click to expand
        await newPage.click(dropdownWrapper);

        // select option based on pincode lookup in Excel files (DTDC.xlsx and Delhivery.xlsx)
        let selected = false;
        // track which carrier we selected for reporting
        let selectedCarrier = null;
        try {
          // try to determine pincode: the caller may pass it via options object
          // check if the function was called with a pincode in the options (e.g., syncShiprocketForOrder(orderId, { pincode }))
          const maybePincode = (arguments[1] && arguments[1].pincode) || null;

          // use cached excel sets (load if needed)
          loadExcelCaches();
          const dtdcSet = _excelCache.DTDC || new Set();
          const delhiverySet = _excelCache.Delhivery || new Set();

          // Helper to try selecting an option by visible text
          const trySelectByText = async (text) => {
            const selCandidates = [
              `#select2-logistics-results li.select2-results__option`,
              `ul.select2-results__options li.select2-results__option`,
              `#logisticsModal .select2-results__option`,
              `#logisticsModal .dropdown-menu li`,
              `#logisticsModal li`,
            ];
            for (const sel of selCandidates) {
              try {
                const locator = newPage.locator(sel).filter({ hasText: text });
                const count = await locator.count();
                if (count > 0) {
                  await locator
                    .first()
                    .click({ timeout: 2000, force: true })
                    .catch(() => {});
                  await newPage.waitForTimeout(250);
                  return true;
                }
              } catch (e) {
                // ignore
              }
            }
            // fallback: try find in DOM under #logisticsModal
            try {
              const found = await newPage.evaluate((txt) => {
                const modal = document.querySelector("#logisticsModal");
                if (!modal) return false;
                const items = Array.from(
                  modal.querySelectorAll("li, option, div")
                );
                const match = items.find(
                  (i) => i.innerText && i.innerText.trim() === txt
                );
                if (match) {
                  try {
                    match.click();
                  } catch (e) {
                    /* ignore */
                  }
                  return true;
                }
                return false;
              }, text);
              if (found) return true;
            } catch (e) {
              // ignore
            }
            return false;
          };

          // if we have a pincode passed in, prefer that, otherwise fallback to checking call-site info
          const pc = maybePincode;
          if (pc && dtdcSet.has(pc)) {
            selected = await trySelectByText("DTDC");
            if (selected) selectedCarrier = "DTDC";
          } else if (pc && delhiverySet.has(pc)) {
            selected = await trySelectByText("Delhivery");
            if (selected) selectedCarrier = "Delhivery";
          } else {
            // If caller didn't pass pincode, we can try to read from the page if present
            // Attempt to find any pincode text in modal that matches our sets
            try {
              const modalText = await newPage.evaluate(() => {
                const m = document.querySelector("#logisticsModal");
                return m ? m.innerText : "";
              });
              if (modalText) {
                const found = extractPincode(modalText);
                if (found && found.length) {
                  const p = found[0];
                  if (dtdcSet.has(p)) {
                    selected = await trySelectByText("DTDC");
                    if (selected) selectedCarrier = "DTDC";
                  } else if (delhiverySet.has(p)) {
                    selected = await trySelectByText("Delhivery");
                    if (selected) selectedCarrier = "Delhivery";
                  }
                }
              }
            } catch (e) {
              // ignore
            }
          }

          // If not selected yet, fall back to the original behavior: click the last option available
          if (!selected) {
            const optionSelectors = [
              // Select2 often appends results outside the modal with this id
              "#select2-logistics-results li.select2-results__option",
              // Generic Select2 container
              "ul.select2-results__options li.select2-results__option",
              // modal-local option containers
              "#logisticsModal ul li",
              "#logisticsModal li",
              "#logisticsModal select option",
              "#logisticsModal .select2-results__option",
              "#logisticsModal .dropdown-menu li",
              `${dropdownWrapper} + .select2-dropdown li`,
            ];

            for (const sel of optionSelectors) {
              try {
                const locator = newPage.locator(sel).filter({ hasText: /./ });
                const count = await locator.count();
                if (count > 0) {
                  // click the last item (force in case of Select2 overlay)
                  await locator
                    .nth(count - 1)
                    .click({ timeout: 2000, force: true })
                    .catch(() => {});
                  // let UI update
                  await newPage.waitForTimeout(250);
                  selected = true;
                  // best-effort: try to read the clicked element's text to infer carrier
                  try {
                    const txt = await locator.nth(count - 1).innerText();
                    if (txt && /DTDC/i.test(txt)) selectedCarrier = "DTDC";
                    else if (txt && /Delhivery/i.test(txt))
                      selectedCarrier = "Delhivery";
                  } catch (ee) {
                    // ignore
                  }
                  break;
                }
              } catch (e) {
                // ignore selector failures
              }
            }
          }
        } catch (e) {
          // ignore selection failures
        }
      } catch (e) {
        // dropdown didn't appear or selection failed - continue to try next steps
      }

      // select radio #chk_lst_yes if present - use evaluate fallback to avoid hang
      try {
        const found = await newPage
          .waitForSelector("#chk_lst_yes", {
            state: "visible",
            timeout: 3000,
          })
          .catch(() => null);
        if (found) {
          // set checked via DOM and dispatch events
          await newPage.evaluate(() => {
            const el = document.querySelector("#chk_lst_yes");
            if (!el) return;
            try {
              el.checked = true;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            } catch (ee) {
              // ignore
            }
          });
        }
      } catch (e) {
        // ignore if radio not found
      }

      // wait a few seconds to allow any async popup process to run
      await newPage.waitForTimeout(waitMs);

      // Special handling for order 1599: perform logistic sync, fetch and save
      try {
        // normalize orderId for comparison
        const orderNumeric = Number(orderId);
        if (orderId !== "" || orderNumeric !== 0) {
          // 1) click on submit button with selector #logistic_sync
          try {
            await newPage.waitForSelector("#logistic_sync", {
              state: "visible",
              timeout: 3000,
            });
            // accept any native confirm/alert dialog that may appear when submitting
            newPage.once("dialog", async (dialog) => {
              try {
                await dialog.accept();
              } catch (ee) {
                // ignore dialog accept failures
              }
            });
            await newPage.click("#logistic_sync");
          } catch (e) {
            // if logistic_sync not found, continue - non-fatal
          }

          // 2) wait for the process to complete — detect modal close or wait a bit
          try {
            // Wait for any modal under #logisticsModal to disappear, or timeout
            await newPage.waitForSelector("#logisticsModal", {
              state: "detached",
              timeout: 8000,
            });
          } catch (e) {
            // fallback: short fixed wait to allow process to complete
            await newPage.waitForTimeout(2500);
          }

          // close popup by clicking #SyncClose if present
          await this.CloseSyncPopup(newPage);

          // 3) once the popup is closed, click on fetch button on the main page
          try {
            const fetchSel =
              "body > div.wrapper > div.content-wrapper > section > div.row > div > div.row.col-mb-4 > div:nth-child(3) > div:nth-child(1) > button";
            await newPage.waitForSelector(fetchSel, {
              state: "visible",
              timeout: 5000,
            });
            // some actions trigger a native confirmation dialog; accept it if shown
            newPage.once("dialog", async (dialog) => {
              try {
                await dialog.accept();
              } catch (ee) {
                // ignore
              }
            });
            await newPage.click(fetchSel);
            // wait for fetch to run
            await newPage.waitForTimeout(3000);
          } catch (e) {
            // fallback small wait if selector not found
            await newPage.waitForTimeout(1500);
          }

          // 4) click on save with selector #save_order
          try {
            await newPage.waitForSelector("#save_order", {
              state: "visible",
              timeout: 5000,
            });
            // accept confirm/alert if the save triggers one
            newPage.once("dialog", async (dialog) => {
              try {
                await dialog.accept();
              } catch (ee) {
                // ignore
              }
            });
            await newPage.click("#save_order");
          } catch (e) {
            // if save button not found, ignore
          }

          // 5) wait for save to complete — look for save button to become disabled or just wait
          try {
            // wait a bit for save operation to complete
            await newPage.waitForTimeout(3000);
          } catch (e) {
            // noop
          }
        }
      } catch (e) {
        // don't let errors here break the main flow
      }

      // additional processing...

      // close popup by clicking #SyncClose if present
      await this.CloseSyncPopup(newPage);

      return { synced: true, carrier: selectedCarrier };
    } catch (e) {
      return { synced: false, reason: e.message, carrier: null };
    } finally {
      // ensure tab is closed
      try {
        await newPage.close();
      } catch (e) {
        // ignore
      }
    }
  }

  async CloseSyncPopup(newPage) {
    try {
      const closeSel = "#SyncClose";
      await newPage.waitForSelector(closeSel, {
        state: "visible",
        timeout: 3000,
      });
      await newPage.click(closeSel);
    } catch (e) {
      // fallback: try pressing Escape
      try {
        await newPage.keyboard.press("Escape");
      } catch (ee) {
        // ignore
      }
    }
  }

  // Wait for the order list table to be visible
  async waitForTable(timeout = 10000) {
    await this.page.waitForSelector(`${this.tableSelector} tbody tr`, {
      state: "visible",
      timeout,
    });
  }

  // Click each row's address button, wait for popup, then close it.
  // This method is defensive: it tries several close selectors and will
  // timeout gracefully per row instead of failing the whole run.
  async clickEachRowAddressPopup({ perRowTimeout = 5000 } = {}) {
    await this.waitForTable();

    // get all rows currently in the table
    const rows = await this.page.$$(`${this.tableSelector} tbody tr`);
    const processed = {
      DTDC: [],
      Delhivery: [],
      Unknown: [],
    };
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Attempt to extract an order id from the address button cell first
        // Selector pattern used by the UI: `#example > tbody > tr:nth-child(1) > td.sorting_1 > button.btn.btn-link.address-show-btn`
        let orderId = null;
        try {
          const addrBtn = await row.$(
            "td.sorting_1 > button.address-show-btn, td.sorting_1 > a.address-show-btn"
          );
          if (addrBtn) {
            // common attributes where an id might be stored
            const attrCandidates = [
              "data-order-id",
              "data-id",
              "data-order",
              "title",
              "aria-label",
            ];
            for (const attr of attrCandidates) {
              try {
                const v = await addrBtn.getAttribute(attr);
                if (v) {
                  orderId = v.trim();
                  break;
                }
              } catch (e) {
                // ignore attribute read errors
              }
            }

            if (!orderId) {
              try {
                const btnText = (await addrBtn.innerText()).trim();
                if (btnText) orderId = btnText;
              } catch (e) {
                // ignore
              }
            }
          }
        } catch (e) {
          // ignore
        }

        // If not found on the button, fallback to row attribute or common cells
        if (!orderId) {
          try {
            const dataAttr = await row.getAttribute("data-order-id");
            if (dataAttr) orderId = dataAttr.trim();
          } catch (e) {
            // ignore
          }
        }

        if (!orderId) {
          const orderCell = await row.$("td.order-id, th.order-id");
          if (orderCell) {
            try {
              orderId = (await orderCell.innerText()).trim();
            } catch (e) {
              // ignore
            }
          }
        }

        if (!orderId) {
          // fallback to first td text
          const firstTd = await row.$("td:first-child");
          if (firstTd) {
            try {
              orderId = (await firstTd.innerText()).trim();
            } catch (e) {
              // ignore
            }
          }
        }
        // If this order is explicitly skipped, close any popup (if it opened)
        // and continue to next row.
        if (orderId && SKIPPED_ORDERS.has(String(orderId).trim())) {
          // eslint-disable-next-line no-console
          console.log(
            `Skipping order ${orderId} as it's listed in SKIPPED_ORDERS`
          );
          continue;
        }

        // find the button within the row using the relative selector
        const btn = await row.$(this.rowButtonSelector);
        if (!btn) {
          // try fallback: any button with address-show-btn within the row
          const fallback = await row.$(
            "button.address-show-btn, a.address-show-btn"
          );
          if (!fallback) {
            // nothing to click on this row
            continue;
          }
          await fallback.click();
        } else {
          await btn.click();
        }

        // wait a short while for popup to appear
        // Try to detect a modal or popup by waiting for either a .modal element
        // or an element that wasn't present before. We'll wait for a short fixed delay
        // then attempt to close using known selectors.
        await this.page.waitForTimeout(1000); // give popup a chance to appear

        // If a centralized address popup handler exists (from LoginPage), use it.
        // This delegates to LoginPage.handleAddressPopup which will inspect and close
        // the #addressShowBody popup if present. It's safe to call and will return
        // quickly if the popup doesn't exist.
        let handleResult = null;
        try {
          // pass 1-based row index and orderId for clearer logs
          handleResult = await this.handleAddressPopup(i + 1, orderId);
        } catch (e) {
          // ignore errors from the delegated handler and continue with local logic
        }

        // If we extracted a pincode and have an orderId, attempt to sync via Shiprocket in a new tab.
        try {
          const pincode = handleResult && handleResult.pincode;
          if (pincode && orderId) {
            // run sync flow for this order; keep it quick and non-blocking per row
            // awaiting here ensures sequential per-row behavior; if you want parallel,
            // you could spawn without await but ensure resource limits.
            const result = await this.syncShiprocketForOrder(orderId, {
              waitMs: 2500,
              pincode,
            });
            try {
              // Prefer the carrier returned by the sync flow if present
              let carrier = result && result.carrier;

              // If sync didn't return a carrier, try to infer from the pincode
              if (!carrier) {
                try {
                  loadExcelCaches();
                  const dtdcSet = _excelCache.DTDC || new Set();
                  const delhiverySet = _excelCache.Delhivery || new Set();
                  if (pincode && dtdcSet.has(pincode)) carrier = "DTDC";
                  else if (pincode && delhiverySet.has(pincode))
                    carrier = "Delhivery";
                } catch (ee) {
                  // ignore cache/read errors
                }
              }

              if (carrier === "DTDC") processed.DTDC.push({ orderId, pincode });
              else if (carrier === "Delhivery")
                processed.Delhivery.push({ orderId, pincode });
              else processed.Unknown.push({ orderId, pincode });
            } catch (e) {
              // ignore push errors
            }
          }
        } catch (e) {
          // log and continue
          // eslint-disable-next-line no-console
          console.warn(
            `row ${i + 1}: error during syncShiprocket - ${e.message}`
          );
        }

        // Per-row logging so user sees immediate progress for each processed row
        try {
          const pcode = (handleResult && handleResult.pincode) || null;
          // determine carrier if we recorded it in processed arrays
          let carrier = null;
          if (processed.DTDC.find((x) => x.orderId === orderId))
            carrier = "DTDC";
          else if (processed.Delhivery.find((x) => x.orderId === orderId))
            carrier = "Delhivery";
          // eslint-disable-next-line no-console
          console.log(
            `Row ${i + 1}: order=${orderId || "N/A"}, pincode=${
              pcode || "N/A"
            }, carrier=${carrier || "N/A"}`
          );
        } catch (e) {
          // ignore logging errors per row
        }

        // short pause before next row to stabilize DOM
        await this.page.waitForTimeout(200);
      } catch (e) {
        // continue to next row; do not fail the whole loop
        // but log to console for debugging
        // eslint-disable-next-line no-console
        console.warn(`row ${i + 1}: error handling popup - ${e.message}`);
      }
    }
    // After processing all rows, print a summary and write it to logs
    try {
      const dtdcList = processed.DTDC || [];
      console.log(`Processed on DTDC (${dtdcList.length})`);
      console.log("--------------------------------");
      for (let i = 0; i < dtdcList.length; i++) {
        const item = dtdcList[i];
        console.log(
          `${i + 1}. Order :${item.orderId}, Pincode: ${item.pincode}`
        );
      }

      const delList = processed.Delhivery || [];
      console.log(`\nProcessed on Delhivery (${delList.length})`);
      console.log("--------------------------------");
      for (let i = 0; i < delList.length; i++) {
        const item = delList[i];
        console.log(
          `${i + 1}. Order :${item.orderId}, Pincode: ${item.pincode}`
        );
      }

      const unknownList = processed.Unknown || [];
      console.log(`\nProcessed Unknown (${unknownList.length})`);
      console.log("--------------------------------");
      for (let i = 0; i < unknownList.length; i++) {
        const item = unknownList[i];
        console.log(
          `${i + 1}. Order :${item.orderId}, Pincode: ${item.pincode}`
        );
      }

      // write to logs directory
      try {
        const logsDir = path.join(process.cwd(), "logs");
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = path.join(logsDir, `summary-${ts}.txt`);
        const lines = [];
        lines.push(`Processed on DTDC (${dtdcList.length})`);
        lines.push("--------------------------------");
        for (let i = 0; i < dtdcList.length; i++) {
          const item = dtdcList[i];
          lines.push(
            `${i + 1}. Order :${item.orderId}, Pincode: ${item.pincode}`
          );
        }
        lines.push("");
        lines.push(`Processed on Delhivery (${delList.length})`);
        lines.push("--------------------------------");
        for (let i = 0; i < delList.length; i++) {
          const item = delList[i];
          lines.push(
            `${i + 1}. Order :${item.orderId}, Pincode: ${item.pincode}`
          );
        }
        lines.push("");
        lines.push(`Processed Unknown (${unknownList.length})`);
        lines.push("--------------------------------");
        for (let i = 0; i < unknownList.length; i++) {
          const item = unknownList[i];
          lines.push(
            `${i + 1}. Order :${item.orderId}, Pincode: ${item.pincode}`
          );
        }
        fs.writeFileSync(filename, lines.join("\n"));
        console.log(`Summary written to ${filename}`);
      } catch (e) {
        // ignore file write errors
      }
    } catch (e) {
      // ignore logging errors
    }
  }
}

module.exports = { OrderListPage, extractPincode };
