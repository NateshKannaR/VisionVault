/**
 * task-checklist.js — Cross-page, multi-step task tracking for VisionVault.
 *
 * Generates an upfront milestone checklist on turn 1 and tracks completion
 * across page reloads and cross-domain navigations so the agent doesn't
 * lose context or re-decide from scratch every reload.
 */

(function (global) {
  /**
   * Generates a step checklist from the parsed task instruction.
   * @param {string} taskText - Raw user instruction.
   * @param {object} parsed - Parsed task object from TaskParser/TaskPlanner.
   * @returns {Array<{id: string, label: string, status: string, detail?: string}>}
   */
  function generateTaskChecklist(taskText, parsed) {
    const p = parsed || {};
    const items = [];

    // Step 1: Site Navigation (if specified)
    if (p.site || p.targetUrl) {
      items.push({
        id: "navigate",
        label: `Navigate to ${p.site || "target site"}`,
        status: "pending",
        detail: p.targetUrl || p.site || "",
      });
    }

    // Step 2: Form filling or Search
    if (p.isFormFill) {
      items.push({
        id: "fill_form",
        label: "Fill form fields using on-device Vault",
        status: "pending",
        detail: "Zero plaintext transmitted to cloud VLM",
      });
    } else if (p.query) {
      items.push({
        id: "search",
        label: `Search for "${p.query}"`,
        status: "pending",
        detail: p.query,
      });
    }

    // Step 3: Filters or Specific Sub-actions
    if (p.filterNonStop) {
      items.push({
        id: "filter_non_stop",
        label: "Apply 'Non-Stop' flight filter",
        status: "pending",
      });
    }
    if (p.filterBrand) {
      items.push({
        id: "filter_brand",
        label: `Filter by brand: ${p.filterBrand}`,
        status: "pending",
      });
    }
    if (p.sortOrder) {
      items.push({
        id: "sort",
        label: `Sort results (${p.sortOrder})`,
        status: "pending",
      });
    }
    if (p.githubStar) {
      items.push({
        id: "github_star",
        label: "Star GitHub repository",
        status: "pending",
      });
    }
    if (p.githubFork) {
      items.push({
        id: "github_fork",
        label: "Fork GitHub repository",
        status: "pending",
      });
    }

    // Step 4: Product selection / click target
    if (p.openTarget) {
      items.push({
        id: "select_target",
        label: `Select "${p.openTarget}"`,
        status: "pending",
      });
    } else if (p.openFirst) {
      items.push({
        id: "select_first",
        label: "Open first matching result",
        status: "pending",
      });
    } else if (p.addToCart) {
      items.push({
        id: "add_to_cart",
        label: "Add selected product to cart",
        status: "pending",
      });
    }

    // Step 5: Verification & Completion
    items.push({
      id: "verify_complete",
      label: "Verify task completion & display results",
      status: "pending",
    });

    // If no specific steps were identified, provide generic robust steps
    if (items.length <= 1) {
      return [
        { id: "analyze_page", label: "Analyze page layout & interactive marks", status: "in_progress" },
        { id: "execute_instruction", label: `Execute: ${taskText.slice(0, 50)}...`, status: "pending" },
        { id: "verify_complete", label: "Verify execution outcome", status: "pending" }
      ];
    }

    // Set first step to in_progress
    if (items[0]) {
      items[0].status = "in_progress";
    }

    return items;
  }

  /**
   * Updates checklist statuses based on the action performed and current page context.
   * @param {Array} checklist - Current checklist items.
   * @param {object} action - Action just planned or executed.
   * @param {object} context - { currentUrl, pageTitle, progress }
   * @returns {Array} Updated checklist.
   */
  function updateChecklist(checklist, action, context) {
    if (!Array.isArray(checklist) || checklist.length === 0) return checklist;
    const ctx = context || {};
    const prog = ctx.progress || {};

    const updated = checklist.map(item => ({ ...item }));

    // Mark steps completed based on progress flags or action
    for (let i = 0; i < updated.length; i++) {
      const item = updated[i];

      if (item.id === "navigate") {
        if (prog.navigated || (action && action.action === "navigate")) {
          item.status = "done";
        }
      }

      if (item.id === "search") {
        if (prog.searched || (action && action.action === "type" && action.text)) {
          item.status = "done";
        }
      }

      if (item.id === "fill_form") {
        if (prog.formFilled || (action && (action.action === "batch_form_fill" || action.action === "type_sensitive"))) {
          item.status = "done";
        }
      }

      if (item.id === "filter_non_stop" && prog.nonStopFiltered) {
        item.status = "done";
      }

      if (item.id === "sort" && prog.sortApplied) {
        item.status = "done";
      }

      if (item.id === "github_star" && prog.starred) {
        item.status = "done";
      }

      if (item.id === "github_fork" && prog.forked) {
        item.status = "done";
      }

      if (item.id === "add_to_cart" && prog.cartAdded) {
        item.status = "done";
      }

      if ((item.id === "select_target" || item.id === "select_first") && (prog.opened?.length > 0 || (action && action.isProductSelection))) {
        item.status = "done";
      }

      if (item.id === "verify_complete" || item.id === "execute_instruction") {
        if (action && action.action === "finish") {
          item.status = "done";
        }
      }
    }

    // Find the first non-done step and mark it in_progress if still pending
    let activeFound = false;
    for (let i = 0; i < updated.length; i++) {
      if (updated[i].status !== "done" && updated[i].status !== "skipped") {
        if (!activeFound) {
          updated[i].status = "in_progress";
          activeFound = true;
        } else {
          updated[i].status = "pending";
        }
      }
    }

    return updated;
  }

  const TaskChecklist = {
    generateTaskChecklist,
    updateChecklist,
  };

  global.TaskChecklist = TaskChecklist;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = TaskChecklist;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
