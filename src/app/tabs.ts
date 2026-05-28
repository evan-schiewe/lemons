import type { AppRefs } from './refs';

const TAB_ROUTES = {
  chart: '',
  timeline: 'timeline',
  annotations: 'annotations',
  data: 'data',
} as const;

type TabName = keyof typeof TAB_ROUTES;

const DEFAULT_TAB: TabName = 'chart';

export function setupTabSwitching(
  refs: AppRefs,
  {
    isLocalEditingEnabled,
    onChartTabShown,
  }: {
    isLocalEditingEnabled: boolean;
    onChartTabShown?: () => void;
  },
): void {
  syncAnnotationsTabVisibility(refs, isLocalEditingEnabled);

  refs.tabButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      const clickedButton = event.currentTarget as HTMLButtonElement;
      const tabName = clickedButton.dataset.tab;
      if (!tabName) {
        return;
      }

      activateTab(refs, tabName, {
        onChartTabShown,
        updateUrl: true,
      });
    });
  });

  activateTabFromLocation(refs, { onChartTabShown, replaceUrl: true });

  window.addEventListener('popstate', () => {
    activateTabFromLocation(refs, { onChartTabShown });
  });
}

export function syncAnnotationsTabVisibility(
  refs: AppRefs,
  isVisible: boolean,
): void {
  const annotationsTabButton = Array.from(refs.tabButtons).find(
    (button) => button.dataset.tab === 'annotations',
  );
  const annotationsTabContent = Array.from(refs.tabContents).find(
    (content) => content.id === 'annotations-tab',
  );
  if (annotationsTabButton) {
    annotationsTabButton.hidden = !isVisible;
  }
  if (annotationsTabContent) {
    annotationsTabContent.hidden = !isVisible;
  }

  if (!isVisible && annotationsTabButton?.classList.contains('active')) {
    const chartTabButton = Array.from(refs.tabButtons).find(
      (button) => button.dataset.tab === 'chart',
    );
    chartTabButton?.click();
  }
}

function activateTabFromLocation(
  refs: AppRefs,
  {
    onChartTabShown,
    replaceUrl = false,
  }: {
    onChartTabShown?: () => void;
    replaceUrl?: boolean;
  },
): void {
  const tabName = getTabNameFromLocation();
  if (
    tabName &&
    activateTab(refs, tabName, {
      onChartTabShown,
      replaceUrl,
      updateUrl: false,
    })
  ) {
    return;
  }

  activateTab(refs, DEFAULT_TAB, {
    onChartTabShown,
    replaceUrl: true,
    updateUrl: true,
  });
}

function activateTab(
  refs: AppRefs,
  tabName: string,
  {
    onChartTabShown,
    replaceUrl = false,
    updateUrl = false,
  }: {
    onChartTabShown?: () => void;
    replaceUrl?: boolean;
    updateUrl?: boolean;
  } = {},
): boolean {
  if (!isTabName(tabName)) {
    return false;
  }

  const clickedButton = Array.from(refs.tabButtons).find(
    (button) => button.dataset.tab === tabName,
  );
  if (!clickedButton || clickedButton.hidden) {
    return false;
  }

  refs.tabButtons.forEach((tabButton) => {
    tabButton.classList.remove('active');
  });
  clickedButton.classList.add('active');

  refs.tabContents.forEach((content) => {
    content.classList.remove('active');
  });
  const activeTab = document.querySelector<HTMLElement>(`#${tabName}-tab`);
  if (activeTab) {
    activeTab.classList.add('active');
    if (tabName === 'chart') {
      setTimeout(() => onChartTabShown?.(), 50);
    }
  }

  if (updateUrl) {
    updateUrlForTab(tabName, replaceUrl);
  }

  localStorage.setItem('activeTab', tabName);
  return true;
}

function isTabName(value: string): value is TabName {
  return Object.hasOwn(TAB_ROUTES, value);
}

function getTabNameFromLocation(): TabName | null {
  const basePath = getBasePath();
  const basePathWithoutTrailingSlash =
    basePath.length > 1 ? basePath.slice(0, -1) : basePath;
  let routePath: string | null = null;

  if (
    window.location.pathname === basePath ||
    window.location.pathname === basePathWithoutTrailingSlash
  ) {
    routePath = '';
  } else if (window.location.pathname.startsWith(basePath)) {
    routePath = window.location.pathname.slice(basePath.length);
  } else if (basePath !== '/' && window.location.pathname === '/') {
    routePath = '';
  }

  if (routePath === null) {
    return null;
  }

  const routeSlug = trimSlashes(routePath);
  const tabRoute = Object.entries(TAB_ROUTES).find(
    ([, tabSlug]) => tabSlug === routeSlug,
  );

  return tabRoute ? (tabRoute[0] as TabName) : null;
}

function updateUrlForTab(tabName: TabName, replaceUrl: boolean): void {
  const nextUrl = getUrlForTab(tabName);
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) {
    return;
  }

  if (replaceUrl) {
    window.history.replaceState(null, document.title, nextUrl);
    return;
  }

  window.history.pushState(null, document.title, nextUrl);
}

function getUrlForTab(tabName: TabName): string {
  const url = new URL(window.location.href);
  const routeSlug = TAB_ROUTES[tabName];
  const basePath = getBasePath();
  url.pathname = routeSlug ? `${basePath}${routeSlug}` : basePath;
  return `${url.pathname}${url.search}${url.hash}`;
}

function getBasePath(): string {
  const basePath = new URL(import.meta.env.BASE_URL, window.location.origin)
    .pathname;
  return basePath.endsWith('/') ? basePath : `${basePath}/`;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

export function syncDataTabAndActions(refs: AppRefs, hasData: boolean): void {
  refs.dataTabButton.hidden = !hasData;

  const activeDataButton = Array.from(refs.tabButtons).find(
    (button) =>
      button.dataset.tab === 'data' && button.classList.contains('active'),
  );
  if (!hasData && activeDataButton) {
    const chartButton = Array.from(refs.tabButtons).find(
      (button) => button.dataset.tab === 'chart',
    );
    chartButton?.click();
  }

  const targetHost = hasData ? refs.dataActionsSlot : refs.heroActionsHost;
  if (refs.dataActions.parentElement !== targetHost) {
    targetHost.append(refs.dataActions);
  }
  if (refs.syncControls.parentElement !== targetHost) {
    targetHost.append(refs.syncControls);
  }

  refs.heroActionsHost.hidden = hasData;
}

export function setupAnnotationSubtabs(refs: AppRefs): void {
  refs.annotationSubtabButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      const clickedButton = event.currentTarget as HTMLButtonElement;
      const subtabName = clickedButton.dataset.annotationTab;
      if (!subtabName) {
        return;
      }

      refs.annotationSubtabButtons.forEach((subtabButton) => {
        subtabButton.classList.remove('active');
        subtabButton.setAttribute('aria-selected', 'false');
      });
      clickedButton.classList.add('active');
      clickedButton.setAttribute('aria-selected', 'true');

      refs.annotationSubtabContents.forEach((content) => {
        content.classList.remove('active');
        content.hidden = true;
      });

      const activeSubtab = document.querySelector<HTMLElement>(
        `#annotation-${subtabName}-tab`,
      );
      if (activeSubtab) {
        activeSubtab.classList.add('active');
        activeSubtab.hidden = false;
      }

      localStorage.setItem('activeAnnotationSubtab', subtabName);
    });
  });

  const savedSubtab =
    localStorage.getItem('activeAnnotationSubtab') || 'editor';
  const savedSubtabButton = Array.from(refs.annotationSubtabButtons).find(
    (button) => button.dataset.annotationTab === savedSubtab,
  );
  savedSubtabButton?.click();
}
