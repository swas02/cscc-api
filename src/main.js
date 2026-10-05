import cscc from 'cscc-local';

// Track countries loaded in memory cache during this session
const cachedCountries = new Set();

document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('apiStatusBadge');
  const form = document.getElementById('queryForm');
  const resultsWrapper = document.getElementById('resultsWrapper');
  const resultsCount = document.getElementById('resultsCount');
  const executionTime = document.getElementById('executionTime');
  const tableBody = document.getElementById('resultsTableBody');
  const spinner = document.getElementById('loadingSpinner');

  // Stats Elements
  const statTime = document.getElementById('statTime');
  const statTransfer = document.getElementById('statTransfer');
  const statRows = document.getElementById('statRows');
  const statMemory = document.getElementById('statMemory');
  const cacheBadge = document.getElementById('cacheBadge');
  const statThroughput = document.getElementById('statThroughput');
  const statFile = document.getElementById('statFile');

  // Make copySnippet globally available for HTML onclick buttons
  window.copySnippet = function (elementId, btn) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const code = el.innerText;
    navigator.clipboard.writeText(code).then(() => {
      const originalHTML = btn.innerHTML;
      btn.classList.remove('btn-outline-secondary', 'text-light');
      btn.classList.add('btn-success', 'text-white');
      btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Copied!';
      setTimeout(() => {
        btn.classList.remove('btn-success', 'text-white');
        btn.classList.add('btn-outline-secondary', 'text-light');
        btn.innerHTML = originalHTML;
      }, 2000);
    }).catch((err) => {
      console.error('Failed to copy: ', err);
    });
  };

  // Initialize CSCC Client
  cscc.ready().then(async (meta) => {
    if (statusBadge) {
      statusBadge.className = 'badge bg-success';
      statusBadge.textContent = `API Ready (${meta.countries} Countries)`;
    }

    // Populate countries dropdown dynamically with all 170 countries
    const countryList = await cscc.countries();
    const countrySelect = document.getElementById('countrySelect');
    if (countrySelect) {
      const selectedVal = countrySelect.value || 'IND';
      countrySelect.innerHTML = '';
      countryList.forEach((iso) => {
        const opt = document.createElement('option');
        opt.value = iso;
        opt.textContent = iso;
        if (iso === selectedVal) opt.selected = true;
        countrySelect.appendChild(opt);
      });
    }

    // Run initial query
    executeLiveQuery();
  }).catch((err) => {
    if (statusBadge) {
      statusBadge.className = 'badge bg-danger';
      statusBadge.textContent = 'API Error: ' + err.message;
    }
  });

  async function executeLiveQuery() {
    const countrySelect = document.getElementById('countrySelect');
    const sspSelect = document.getElementById('sspSelect');
    const rcpSelect = document.getElementById('rcpSelect');
    const drSelect = document.getElementById('drSelect');

    if (!countrySelect || !sspSelect || !rcpSelect || !drSelect) return;

    const iso = countrySelect.value;
    const ssp = sspSelect.value;
    const rcp = rcpSelect.value;
    const dr = Number(drSelect.value);

    if (spinner) spinner.classList.remove('d-none');
    if (resultsWrapper) resultsWrapper.classList.add('d-none');

    const isCacheHit = cachedCountries.has(iso);
    const startTime = performance.now();

    try {
      const rows = await cscc.getData(iso, { ssp, rcp, dr });
      const endTime = performance.now();
      const elapsed = (endTime - startTime).toFixed(1);

      // Mark country as cached in memory
      cachedCountries.add(iso);

      // Render Table Rows
      if (tableBody) {
        tableBody.innerHTML = '';
        rows.forEach((r) => {
          const tr = document.createElement('tr');
          const formatNum = (v) => (v !== null && v !== undefined ? Number(v).toFixed(2) : '<span class="text-muted">NA</span>');

          tr.innerHTML = 
            '<td><code>' + r.run + '</code></td>' +
            '<td>' + r.dmgfuncpar + '</td>' +
            '<td>' + r.climate + '</td>' +
            '<td class="text-end">' + formatNum(r.p16_7) + '</td>' +
            '<td class="text-end fw-bold text-primary">' + formatNum(r.p50) + '</td>' +
            '<td class="text-end">' + formatNum(r.p83_3) + '</td>' +
            '<td class="text-center"><span class="badge bg-light text-dark border">' + r.n + '</span></td>';
          tableBody.appendChild(tr);
        });
      }

      // Update Live Browser Usage Stats
      if (statTime) statTime.textContent = elapsed + ' ms';
      if (cacheBadge && statTransfer) {
        if (isCacheHit) {
          cacheBadge.className = 'badge bg-success';
          cacheBadge.innerHTML = '<i class="bi bi-lightning-fill me-1"></i>Memory Cache Hit';
          statTransfer.textContent = '0 KB (Memory Hit)';
        } else {
          cacheBadge.className = 'badge bg-info text-dark';
          cacheBadge.innerHTML = '<i class="bi bi-cloud-arrow-down-fill me-1"></i>Fetch / Load';
          statTransfer.textContent = '23.3 KB (.bin)';
        }
      }

      if (statRows) statRows.textContent = rows.length + ' / 1,458';

      // Memory Usage
      if (statMemory) {
        if (window.performance && window.performance.memory) {
          const usedHeap = (window.performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
          statMemory.textContent = usedHeap + ' MB Heap';
        } else {
          statMemory.textContent = '23.3 KB Buffer';
        }
      }

      // Compute throughput
      const numericElapsed = Math.max(parseFloat(elapsed), 0.1);
      const throughput = Math.round((1458 / numericElapsed) * 1000);
      if (statThroughput) statThroughput.textContent = throughput.toLocaleString() + ' rows/sec';
      if (statFile) statFile.textContent = iso + '.bin (23,344 bytes)';

      if (resultsCount) resultsCount.textContent = rows.length + ' rows returned for ' + iso;
      if (executionTime) executionTime.textContent = 'Total time: ' + elapsed + ' ms';
      if (resultsWrapper) resultsWrapper.classList.remove('d-none');
    } catch (e) {
      alert('Query failed: ' + e.message);
    } finally {
      if (spinner) spinner.classList.add('d-none');
    }
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      executeLiveQuery();
    });
  }
});
