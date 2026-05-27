import type { AppRefs } from './refs';

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
  const annotationsTabButton = Array.from(refs.tabButtons).find(
    (button) => button.dataset.tab === 'annotations',
  );
  if (annotationsTabButton) {
    annotationsTabButton.hidden = !isLocalEditingEnabled;
  }

  refs.tabButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      const clickedButton = event.currentTarget as HTMLButtonElement;
      const tabName = clickedButton.dataset.tab;
      if (!tabName) {
        return;
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

      localStorage.setItem('activeTab', tabName);
    });
  });

  const savedTab = localStorage.getItem('activeTab') || 'chart';
  const savedTabButton = Array.from(refs.tabButtons).find(
    (button) => button.dataset.tab === savedTab && !button.hidden,
  );
  if (savedTabButton) {
    savedTabButton.click();
    return;
  }

  const chartTabButton = Array.from(refs.tabButtons).find(
    (button) => button.dataset.tab === 'chart',
  );
  chartTabButton?.click();
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
