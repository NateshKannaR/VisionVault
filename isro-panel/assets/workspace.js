(() => {
  const menu = document.querySelector(".workspace-menu");
  const navigation = document.getElementById("workspace-navigation");
  const main = document.getElementById("workspace-content");
  const currentSection = menu.querySelector("[data-current-section]");
  const defaultPage = document.body.dataset.startPage;
  let restoringLocation = false;

  function syncNavigation() {
    const page = main.querySelector(".page.active");
    if (!page) return;

    let currentLink;
    navigation.querySelectorAll("[data-page]").forEach((link) => {
      if (link.getAttribute("aria-controls") === page.id) {
        link.setAttribute("aria-current", "page");
        currentLink = link;
      } else {
        link.removeAttribute("aria-current");
      }
    });

    const label = currentLink?.querySelector(".workspace-link-label") || page.querySelector("h1");
    if (label) currentSection.textContent = label.textContent.trim();

    const fragment = "#" + page.id;
    if (!restoringLocation && location.hash !== fragment) {
      const url = new URL(location.href);
      url.hash = fragment;
      history.pushState(null, "", url);
    }
  }

  function restorePage() {
    const fragment = location.hash.slice(1);
    const match = fragment.startsWith("page-") && document.getElementById(fragment);
    const pageId = match && main.contains(match) && match.classList.contains("page")
      ? match.id.slice("page-".length)
      : defaultPage;
    restoringLocation = true;
    navigateToPage(pageId);
    restoringLocation = false;
  }

  document.querySelector(".workspace-skip").addEventListener("click", (event) => {
    event.preventDefault();
    main.focus();
  });

  menu.addEventListener("click", () => {
    const isOpen = menu.getAttribute("aria-expanded") === "true";
    menu.setAttribute("aria-expanded", String(!isOpen));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.getAttribute("aria-expanded") !== "true" || !menu.offsetWidth) return;
    menu.setAttribute("aria-expanded", "false");
    menu.focus();
  });

  document.addEventListener("click", (event) => {
    const shortcut = event.target.closest("[data-open-page]");
    const navItem = event.target.closest("#workspace-navigation [data-page]");
    if (!shortcut && !navItem) return;

    if (shortcut) navigateToPage(shortcut.dataset.openPage);
    menu.setAttribute("aria-expanded", "false");
    const heading = main.querySelector(".page.active h1");
    if (heading) heading.focus();
  });

  document.addEventListener("workspacechange", syncNavigation);
  window.addEventListener("popstate", restorePage);
  document.body.dataset.navigationReady = "";
  restorePage();
})();
