import { escapeHtml } from '../../utils/format.js';

const KIND_CONFIG = {
  lapNote: { formId: 'lap-note-form', title: 'Lap Note', listKey: 'lapNotes' },
  taggedIncident: { formId: 'tagged-incident-form', title: 'Tagged Incident', listKey: 'taggedIncidents' },
  rangeEvent: { formId: 'range-event-form', title: 'Range Event', listKey: 'rangeEvents' },
  driverStint: { formId: 'driver-stint-form', title: 'Driver Stint', listKey: 'driverStints' },
};

export function mountAnnotationPanel(container, handlers) {
  const state = { viewModel: null };

  container.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target.closest('form[data-kind]');
    if (!form) {
      return;
    }

    const formData = new FormData(form);
    const kind = form.dataset.kind;
    await handlers.onSave(kind, normalizeFormData(kind, formData));
  });

  container.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    const kind = button.dataset.kind;

    if (action === 'delete') {
      await handlers.onDelete(kind, button.dataset.id);
      return;
    }

    if (action === 'edit') {
      hydrateForm(container.querySelector(`form[data-kind="${kind}"]`), findItem(state.viewModel, kind, button.dataset.id));
      return;
    }

    if (action === 'clear') {
      hydrateForm(container.querySelector(`form[data-kind="${kind}"]`), null, state.viewModel?.selectedLapRow);
    }
  });

  return {
    render(viewModel) {
      state.viewModel = viewModel;
      container.innerHTML = renderPanel(viewModel);
    },
  };
}

function renderPanel(viewModel) {
  const selected = viewModel.selectedLapRow;

  return `
    <section class="annotation-section">
      <strong>${selected ? `Lap ${escapeHtml(selected.lap_number)}` : 'No selected lap'}</strong>
      <p class="annotation-meta">${selected ? escapeHtml(selected.driver_name || 'Unknown driver') : 'Select a lap in the table or charts to prefill forms.'}</p>
    </section>
    ${renderLapNoteForm(selected)}
    ${renderIncidentForm(selected)}
    ${renderRangeEventForm(selected)}
    ${renderDriverStintForm(selected)}
    ${renderListSection('Lap Notes', 'lapNote', viewModel.annotations.lapNotes, renderLapNoteItem)}
    ${renderListSection('Tagged Incidents', 'taggedIncident', viewModel.annotations.taggedIncidents, renderTaggedIncidentItem)}
    ${renderListSection('Range Events', 'rangeEvent', viewModel.annotations.rangeEvents, renderRangeEventItem)}
    ${renderListSection('Driver Stints', 'driverStint', viewModel.annotations.driverStints, renderDriverStintItem)}
  `;
}

function renderLapNoteForm(selected) {
  return `
    <section class="annotation-section">
      <h3>Lap Note</h3>
      <form id="lap-note-form" data-kind="lapNote">
        <input type="hidden" name="id" />
        <label><span>Lap</span><input name="lap_number" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>Driver</span><input name="driver_name" value="${escapeHtml(selected?.driver_name ?? '')}" /></label>
        <label><span>Note</span><textarea name="note_text" rows="3" required></textarea></label>
        <label><span>Color</span><input name="color" type="color" value="#f59e0b" /></label>
        <div class="form-actions">
          <button class="button primary" type="submit">Save Lap Note</button>
          <button class="button ghost" data-action="clear" data-kind="lapNote" type="button">Clear</button>
        </div>
      </form>
    </section>
  `;
}

function renderIncidentForm(selected) {
  return `
    <section class="annotation-section">
      <h3>Tagged Incident</h3>
      <form id="tagged-incident-form" data-kind="taggedIncident">
        <input type="hidden" name="id" />
        <label><span>Lap</span><input name="lap_number" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>Title</span><input name="title" required /></label>
        <label><span>Tag</span><input name="tag" placeholder="Spin, contact, FCY" required /></label>
        <label><span>Details</span><textarea name="details" rows="2"></textarea></label>
        <label><span>Color</span><input name="color" type="color" value="#d94f2b" /></label>
        <div class="form-actions">
          <button class="button primary" type="submit">Save Incident</button>
          <button class="button ghost" data-action="clear" data-kind="taggedIncident" type="button">Clear</button>
        </div>
      </form>
    </section>
  `;
}

function renderRangeEventForm(selected) {
  return `
    <section class="annotation-section">
      <h3>Range Event</h3>
      <form id="range-event-form" data-kind="rangeEvent">
        <input type="hidden" name="id" />
        <label><span>Start Lap</span><input name="start_lap" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>End Lap</span><input name="end_lap" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>Title</span><input name="title" required /></label>
        <label><span>Tag</span><input name="tag" placeholder="FCY, caution, weather" required /></label>
        <label><span>Details</span><textarea name="details" rows="2"></textarea></label>
        <label><span>Color</span><input name="color" type="color" value="#2563eb" /></label>
        <div class="form-actions">
          <button class="button primary" type="submit">Save Range</button>
          <button class="button ghost" data-action="clear" data-kind="rangeEvent" type="button">Clear</button>
        </div>
      </form>
    </section>
  `;
}

function renderDriverStintForm(selected) {
  return `
    <section class="annotation-section">
      <h3>Driver Stint</h3>
      <form id="driver-stint-form" data-kind="driverStint">
        <input type="hidden" name="id" />
        <label><span>Driver</span><input name="driver_name" value="${escapeHtml(selected?.driver_name ?? '')}" required /></label>
        <label><span>Start Lap</span><input name="start_lap" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>End Lap</span><input name="end_lap" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
        <label><span>Color</span><input name="color" type="color" value="#059669" /></label>
        <div class="form-actions">
          <button class="button primary" type="submit">Save Stint</button>
          <button class="button ghost" data-action="clear" data-kind="driverStint" type="button">Clear</button>
        </div>
      </form>
    </section>
  `;
}

function renderListSection(title, kind, items, renderItem) {
  return `
    <section class="annotation-section">
      <div class="panel-header">
        <h3>${escapeHtml(title)}</h3>
        <span class="annotation-meta">${items.length}</span>
      </div>
      <div class="annotation-list">
        ${items.length ? items.map((item) => renderItem(item, kind)).join('') : '<div class="annotation-item">None</div>'}
      </div>
    </section>
  `;
}

function renderLapNoteItem(item, kind) {
  return `
    <article class="annotation-item">
  <strong>Lap ${escapeHtml(item.lap_number)}</strong>
      <p>${escapeHtml(item.note_text)}</p>
      <div class="annotation-meta">${escapeHtml(item.driver_name || 'No driver')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderTaggedIncidentItem(item, kind) {
  return `
    <article class="annotation-item">
      <strong>Lap ${escapeHtml(item.lap_number)} · ${escapeHtml(item.tag)}</strong>
      <p>${escapeHtml(item.title)}</p>
      <div class="annotation-meta">${escapeHtml(item.details || 'No details')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderRangeEventItem(item, kind) {
  return `
    <article class="annotation-item">
      <strong>Laps ${escapeHtml(item.start_lap)}-${escapeHtml(item.end_lap)} · ${escapeHtml(item.tag)}</strong>
      <p>${escapeHtml(item.title)}</p>
      <div class="annotation-meta">${escapeHtml(item.details || 'No details')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderDriverStintItem(item, kind) {
  return `
    <article class="annotation-item">
      <strong>${escapeHtml(item.driver_name)} · Laps ${escapeHtml(item.start_lap)}-${escapeHtml(item.end_lap)}</strong>
      <p>${escapeHtml(item.notes || 'No stint notes')}</p>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderItemActions(kind, id) {
  return `
    <div class="form-actions">
      <button class="button ghost" data-action="edit" data-kind="${kind}" data-id="${id}" type="button">Edit</button>
      <button class="button ghost" data-action="delete" data-kind="${kind}" data-id="${id}" type="button">Delete</button>
    </div>
  `;
}

function normalizeFormData(kind, formData) {
  const common = Object.fromEntries(formData.entries());
  const numericFields = {
    lapNote: ['lap_number'],
    taggedIncident: ['lap_number'],
    rangeEvent: ['start_lap', 'end_lap'],
    driverStint: ['start_lap', 'end_lap'],
  }[kind] || [];

  numericFields.forEach((field) => {
    common[field] = Number.parseInt(common[field], 10);
  });

  if (!common.id) {
    delete common.id;
  }

  return common;
}

function findItem(viewModel, kind, id) {
  if (!viewModel) {
    return null;
  }

  const listKey = KIND_CONFIG[kind].listKey;
  return viewModel.annotations[listKey].find((item) => item.id === id) ?? null;
}

function hydrateForm(form, item, selectedLapRow) {
  if (!form) {
    return;
  }

  form.reset();

  const defaults = item ?? buildDefaultValues(form.dataset.kind, selectedLapRow);
  Object.entries(defaults).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (field) {
      field.value = value ?? '';
    }
  });
}

function buildDefaultValues(kind, selectedLapRow) {
  if (!selectedLapRow) {
    return {};
  }

  return {
    lap_number: selectedLapRow.lap_number,
    start_lap: selectedLapRow.lap_number,
    end_lap: selectedLapRow.lap_number,
    driver_name: selectedLapRow.driver_name,
    color: {
      lapNote: '#f59e0b',
      taggedIncident: '#d94f2b',
      rangeEvent: '#2563eb',
      driverStint: '#059669',
    }[kind],
  };
}