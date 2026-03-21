const $ = (s) => document.getElementById(s);

const dropZone = $('dropZone');
const fileInput = $('fileInput');
const fileName = $('fileName');
const btnClearResume = $('btnClearResume');
const btnStart = $('btnStart');
const btnStop = $('btnStop');
const modelSelect = $('modelSelect');
const providerUrl = $('providerUrl');
const providerPort = $('providerPort');
const localProviderSection = $('localProviderSection');
const blacklistInput = $('blacklist');
const logEl = $('log');
const debugLogEl = $('debugLog');
const countSent = $('countSent');
const countTotal = $('countTotal');
const questionSection = $('questionSection');
const qVacancy = $('qVacancy');
const qIndex = $('qIndex');
const qText = $('qText');
const suggestedBlock = $('suggestedBlock');
const suggestedText = $('suggestedText');
const userAnswer = $('userAnswer');
const btnUserAnswer = $('btnUserAnswer');
const btnUseSuggested = $('btnUseSuggested');
const btnLlmAnswer = $('btnLlmAnswer');
const btnSkip = $('btnSkip');
const btnDeduplicate = $('btnDeduplicate');
const btnClearQA = $('btnClearQA');
const providerSelect = $('providerSelect');
const btnProviderSettings = $('btnProviderSettings');
const btnRefreshModels = $('btnRefreshModels');
const providerSettingsPanel = $('providerSettingsPanel');
const apiKeyInput = $('apiKey');
const apiKeySection = $('apiKeySection');
const btnGeneralSettings = $('btnGeneralSettings');
const generalSettingsPanel = $('generalSettingsPanel');
const autoActionNone = $('autoActionNone');
const autoActionLlm = $('autoActionLlm');
const autoActionSkip = $('autoActionSkip');
const autoActionTimeout = $('autoActionTimeout');
const autoActionSettings = $('autoActionSettings');
const dbConfirm = $('dbConfirm');
const qaLog = $('qaLog');
const radioOptions = $('radioOptions');

let resumeText = '';
let running = false;
let currentSuggestedAnswer = null;
let currentQuestionType = 'text';
let currentRadioName = null;

// --- Auto-resize textarea ---
function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
}
userAnswer.addEventListener('input', () => autoResize(userAnswer));

// --- Очистка textarea ---
$('btnClearAnswer').addEventListener('click', () => {
  userAnswer.value = '';
  userAnswer.style.height = 'auto';
  userAnswer.focus();
});

// --- Получение выбранной модели ---
function getModel() {
  return modelSelect.value || 'qwen3:8b';
}

// --- URL провайдера ---
const DEFAULT_PORTS = { ollama: 11434, lmstudio: 1234 };
function getProviderBaseUrl() {
  const provider = providerSelect.value;
  const host = providerUrl.value.trim() || 'localhost';
  const port = parseInt(providerPort.value, 10) || DEFAULT_PORTS[provider] || 11434;
  return `http://${host}:${port}`;
}

function updateLocalProviderUI() {
  const provider = providerSelect.value;
  const isLocal = provider === 'ollama' || provider === 'lmstudio';
  localProviderSection.style.display = isLocal ? '' : 'none';
  if (isLocal) {
    providerPort.placeholder = String(DEFAULT_PORTS[provider]);
  }
}

// --- Показ/скрытие полей ---
function updateApiKeyVisibility() {
  const provider = providerSelect.value;
  const needsKey = provider === 'openai' || provider === 'claude';
  apiKeySection.style.display = needsKey ? '' : 'none';
  updateLocalProviderUI();
}

// --- Загрузка списка моделей от провайдера ---
async function loadModels() {
  const provider = providerSelect.value;
  updateApiKeyVisibility();
  modelSelect.innerHTML = '<option value="">Загрузка...</option>';
  modelSelect.disabled = true;
  const apiKey = apiKeyInput.value.trim();
  const isLocal = provider === 'ollama' || provider === 'lmstudio';
  const baseUrl = isLocal ? getProviderBaseUrl() : undefined;
  const resp = await chrome.runtime.sendMessage({ action: 'list-models', provider, apiKey, baseUrl });
  modelSelect.disabled = false;
  if (resp.ok && resp.models.length > 0) {
    modelSelect.innerHTML = '';
    resp.models.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    });
    // Восстановим ранее выбранную модель
    chrome.storage.local.get('modelName', (data) => {
      if (data.modelName && resp.models.includes(data.modelName)) {
        modelSelect.value = data.modelName;
      }
    });
  } else {
    modelSelect.innerHTML = `<option value="">${resp.error || 'Не удалось загрузить'}</option>`;
  }
}

// --- Настройки провайдера ---
btnProviderSettings.addEventListener('click', () => {
  const visible = providerSettingsPanel.style.display !== 'none';
  providerSettingsPanel.style.display = visible ? 'none' : '';
  if (!visible) {
    updateApiKeyVisibility();
    loadModels();
  }
});

btnRefreshModels.addEventListener('click', () => loadModels());

providerSelect.addEventListener('change', () => {
  updateApiKeyVisibility();
  if (providerSettingsPanel.style.display !== 'none') loadModels();
});

// --- Общие настройки ---
btnGeneralSettings.addEventListener('click', () => {
  const visible = generalSettingsPanel.style.display !== 'none';
  generalSettingsPanel.style.display = visible ? 'none' : '';
});

function updateAutoActionUI() {
  const selected = document.querySelector('input[name="autoAction"]:checked').value;
  autoActionSettings.style.display = (selected === 'llm' || selected === 'skip') ? '' : 'none';
}
document.querySelectorAll('input[name="autoAction"]').forEach(r => r.addEventListener('change', updateAutoActionUI));

// --- Логирование ---
function log(text, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry log-${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

const debugResumeEl = $('debugResumeLog');

function debugResume(label, text) {
  const div = document.createElement('div');
  div.style.borderBottom = '1px solid #1a1a2e';
  div.style.padding = '4px 0';
  div.innerHTML = `<span style="color:#6c63ff; font-weight:bold">${label}</span> <span style="color:#888">(${text.length} сим.)</span><br><span style="color:#ccc; white-space:pre-wrap; font-size:11px">${text}</span>`;
  debugResumeEl.appendChild(div);
  debugResumeEl.scrollTop = debugResumeEl.scrollHeight;
}

// --- PDF парсинг ---
async function parsePDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return text.trim();
}

async function handleFile(file) {
  if (!file || file.type !== 'application/pdf') {
    log('Выберите PDF файл', 'err');
    return;
  }
  fileName.textContent = file.name;
  dropZone.classList.add('has-file');
  dropZone.textContent = file.name;

  debugResumeEl.innerHTML = '';

  try {
    log('Парсинг резюме...');
    const rawText = await parsePDF(file);
    log(`PDF распознан (${rawText.length} символов). Сжимаю через LLM...`);

    const model = getModel();
    const provider = providerSelect.value;
    const apiKey = $('apiKey') ? $('apiKey').value : '';
    const baseUrl = (provider === 'ollama' || provider === 'lmstudio') ? getProviderBaseUrl() : '';

    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'compress-resume',
        resumeText: rawText,
        model, provider, apiKey, baseUrl
      });
      if (resp && resp.ok && resp.compressed) {
        resumeText = resp.compressed;
        log(`Резюме сжато (${rawText.length} → ${resumeText.length} символов)`, 'ok');
        debugResume('Сжатое резюме', resumeText);
      } else {
        resumeText = rawText;
        log(`Не удалось сжать: ${resp?.error || 'неизвестная ошибка'}. Используется оригинал`, 'warn');
      }
    } catch (e) {
      resumeText = rawText;
      log(`LLM недоступна для сжатия: ${e.message}. Используется оригинал`, 'warn');
    }

    await chrome.storage.local.set({ resumeText, resumeFileName: file.name });
    btnStart.disabled = false;
    btnClearResume.style.display = '';
  } catch (e) {
    log(`Ошибка парсинга PDF: ${e.message}`, 'err');
  }
}

// --- Drag & Drop ---
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFile(e.dataTransfer.files[0]);
});

btnClearResume.addEventListener('click', () => {
  resumeText = '';
  fileName.textContent = '';
  dropZone.classList.remove('has-file');
  dropZone.textContent = 'Загрузить резюме (PDF)';
  btnStart.disabled = true;
  btnClearResume.style.display = 'none';
  chrome.storage.local.remove(['resumeText', 'resumeFileName']);
  log('Резюме удалено', 'ok');
});

// --- Восстановление состояния ---
chrome.storage.local.get(['resumeText', 'resumeFileName', 'modelName', 'blacklist', 'provider', 'apiKey', 'autoAction', 'autoActionTimeout', 'providerUrl', 'providerPort', 'dbConfirm'], (data) => {
  if (data.resumeText) {
    resumeText = data.resumeText;
    btnStart.disabled = false;
    dropZone.classList.add('has-file');
    dropZone.textContent = data.resumeFileName || 'Резюме загружено';
    fileName.textContent = data.resumeFileName || '';
    btnClearResume.style.display = '';
    debugResume('Сохранённое резюме', resumeText);
  }
  if (data.providerUrl) {
    providerUrl.value = data.providerUrl;
  }
  if (data.providerPort) {
    providerPort.value = data.providerPort;
  }
  if (data.blacklist) {
    blacklistInput.value = data.blacklist;
  }
  if (data.provider) {
    providerSelect.value = data.provider;
  }
  if (data.apiKey) {
    apiKeyInput.value = data.apiKey;
  }
  if (data.autoAction === 'llm') {
    autoActionLlm.checked = true;
  } else if (data.autoAction === 'skip') {
    autoActionSkip.checked = true;
  }
  if (data.autoActionTimeout !== undefined) {
    autoActionTimeout.value = data.autoActionTimeout;
  }
  if (data.dbConfirm) {
    dbConfirm.checked = true;
  }
  updateAutoActionUI();
  updateApiKeyVisibility();
});

// --- Сообщения от content script ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'log') {
    log(msg.text, msg.level || 'info');
  }
  if (msg.type === 'progress') {
    countSent.textContent = msg.sent;
    countTotal.textContent = msg.total;
  }
  if (msg.type === 'debug-vacancy') {
    const el = $('debugVacancyLog');
    const div = document.createElement('div');
    div.style.borderBottom = '1px solid #1a1a2e';
    div.style.padding = '4px 0';
    div.innerHTML = `<span style="color:#6c63ff; font-weight:bold">${msg.title}</span><br><span style="color:#ccc; white-space:pre-wrap">${msg.text}</span>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }
  if (msg.type === 'debug') {
    const div = document.createElement('div');
    div.style.borderBottom = '1px solid #1a1a2e';
    div.style.padding = '4px 0';
    div.innerHTML = `<span style="color:#6c63ff">${msg.vacancy}</span><br><span style="color:#ff9800">Q:</span> ${msg.question}` + (msg.answer ? `<br><span style="color:#4caf50">A:</span> ${msg.answer}` : '');
    debugLogEl.appendChild(div);
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
  }
  if (msg.type === 'question-pause') {
    questionSection.style.display = '';
    qVacancy.textContent = msg.vacancyTitle;
    qIndex.textContent = `${msg.questionIndex + 1}/${msg.totalQuestions}`;
    qText.textContent = msg.question;
    currentQuestionType = msg.questionType || 'text';
    currentRadioName = msg.radioName || msg.checkboxName || null;

    if ((currentQuestionType === 'radio' || currentQuestionType === 'checkbox') && msg.options) {
      // Показываем варианты, скрываем textarea (кроме "Свой вариант")
      userAnswer.style.display = 'none';
      radioOptions.style.display = '';
      radioOptions.innerHTML = '';
      btnUserAnswer.textContent = 'Отправить выбор';
      suggestedBlock.style.display = 'none';
      btnUseSuggested.style.display = 'none';
      btnLlmAnswer.textContent = 'Отправить LLM';

      const inputType = currentQuestionType === 'radio' ? 'radio' : 'checkbox';
      const llmSelectedIndex = msg.llmSelectedIndex;
      const llmSelectedIndices = msg.llmSelectedIndices || [];

      msg.options.forEach((opt, i) => {
        const label = document.createElement('label');
        label.className = 'radio-option';
        const isOpen = opt.value === 'open';
        const input = document.createElement('input');
        input.type = inputType;
        input.name = 'q-choice';
        input.value = opt.value;
        const span = document.createElement('span');
        span.textContent = `${i + 1}. ${opt.text}`;
        label.appendChild(input);
        label.appendChild(span);

        // Подсветка рекомендации LLM
        if (inputType === 'radio' && llmSelectedIndex === i) {
          label.classList.add('llm-recommended');
        }
        if (inputType === 'checkbox' && llmSelectedIndices.includes(i)) {
          label.classList.add('llm-recommended');
        }

        if (inputType === 'radio') {
          label.addEventListener('click', () => {
            radioOptions.querySelectorAll('.radio-option').forEach(el => el.classList.remove('selected'));
            label.classList.add('selected');
          });
        } else {
          input.addEventListener('change', (e) => {
            if (e.target.checked) {
              label.classList.add('selected');
            } else {
              label.classList.remove('selected');
            }
          });
        }
        radioOptions.appendChild(label);

        // Если "Свой вариант" — добавляем textarea под ним
        if (isOpen) {
          const ta = document.createElement('textarea');
          ta.id = 'openAnswerText';
          ta.placeholder = 'Свой вариант...';
          ta.style.cssText = 'width:100%;background:#16213e;border:1px solid #333;border-radius:4px;color:#e0e0e0;padding:6px 8px;font-size:12px;resize:vertical;min-height:40px;outline:none;font-family:inherit;margin-top:4px;margin-bottom:4px;';
          radioOptions.appendChild(ta);
        }
      });
    } else {
      // Текстовый вопрос
      userAnswer.style.display = '';
      radioOptions.style.display = 'none';
      btnUserAnswer.textContent = 'Отправить мой';
      currentSuggestedAnswer = msg.suggestedAnswer;

      if (msg.suggestedAnswer) {
        // LLM-ответ уже готов — показываем в textarea и в блоке
        userAnswer.value = msg.suggestedAnswer;
        autoResize(userAnswer);
        suggestedBlock.style.display = '';
        suggestedBlock.querySelector('.label').textContent = msg.suggestedSource === 'db' ? 'Найден ответ из базы:' : 'Ответ LLM:';
        suggestedText.textContent = msg.suggestedAnswer;
        btnUseSuggested.style.display = msg.suggestedSource === 'db' ? '' : 'none';
        btnLlmAnswer.textContent = 'Отправить LLM';
      } else {
        userAnswer.value = '';
        userAnswer.style.height = 'auto';
        suggestedBlock.style.display = 'none';
        btnUseSuggested.style.display = 'none';
        btnLlmAnswer.textContent = 'LLM ответит';
      }
    }
  }
  if (msg.type === 'question-done') {
    questionSection.style.display = 'none';
  }
  if (msg.type === 'qa-updated') {
    loadQALog();
  }
  if (msg.type === 'done') {
    running = false;
    btnStart.disabled = false;
    btnStart.style.display = '';
    btnStop.style.display = 'none';
    btnStop.disabled = true;
    questionSection.style.display = 'none';
    log('Готово!', 'ok');
  }
});

// --- Запуск ---
btnStart.addEventListener('click', async () => {
  const model = getModel();
  const blacklist = blacklistInput.value.trim();
  const provider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();
  const autoAction = document.querySelector('input[name="autoAction"]:checked').value;
  const autoTimeout = parseInt(autoActionTimeout.value, 10) || 0;
  const dbConfirmVal = dbConfirm.checked;
  const pUrl = providerUrl.value.trim();
  const pPort = parseInt(providerPort.value, 10) || 0;
  const isLocal = provider === 'ollama' || provider === 'lmstudio';
  const baseUrl = isLocal ? getProviderBaseUrl() : undefined;
  await chrome.storage.local.set({ modelName: model, blacklist, provider, apiKey, autoAction, autoActionTimeout: autoTimeout, dbConfirm: dbConfirmVal, providerUrl: pUrl, providerPort: pPort });

  // Проверка доступности провайдера (через background — без CORS)
  const providerNames = { ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI', claude: 'Claude' };
  const providerName = providerNames[provider] || provider;

  if ((provider === 'openai' || provider === 'claude') && !apiKey) {
    log(`Введите API Key для ${providerName}`, 'err');
    return;
  }

  log(`Проверка ${providerName}...`);
  const healthCheck = await chrome.runtime.sendMessage({ action: 'health-check', provider, apiKey, baseUrl });
  if (!healthCheck.ok) {
    log(`${providerName} недоступна: ${healthCheck.error}`, 'err');
    return;
  }
  log(`${providerName} доступна`, 'ok');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !/hh\.ru/.test(tab.url)) {
    log('Откройте любую страницу hh.ru с вакансиями', 'err');
    return;
  }

  running = true;
  btnStart.disabled = true;
  btnStart.style.display = 'none';
  btnStop.style.display = '';
  btnStop.disabled = false;
  countSent.textContent = '0';
  countTotal.textContent = '0';

  // Запускаем через background service worker
  chrome.runtime.sendMessage({
    action: 'start',
    tabId: tab.id,
    resumeText,
    model,
    blacklist,
    provider,
    apiKey,
    baseUrl,
    autoAction,
    autoTimeout,
    dbConfirm: dbConfirmVal
  });

  log('Запущено! Обрабатываю вакансии...', 'ok');
});

// --- Остановка ---
btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stop' });
  running = false;
  btnStart.disabled = false;
  btnStart.style.display = '';
  btnStop.style.display = 'none';
  btnStop.disabled = true;
  questionSection.style.display = 'none';
  log('Остановлено пользователем', 'warn');
});

// --- Кнопки ответа на вопрос ---
function hideQuestionSection() {
  questionSection.style.display = 'none';
}

btnUserAnswer.addEventListener('click', () => {
  if (currentQuestionType === 'radio') {
    const selected = radioOptions.querySelector('input[name="q-choice"]:checked');
    if (!selected) {
      log('Выберите вариант ответа', 'warn');
      return;
    }
    chrome.runtime.sendMessage({ action: 'question-answer', source: 'user', answer: selected.value });
    hideQuestionSection();
    log('Вариант выбран (пользователем)', 'ok');
  } else if (currentQuestionType === 'checkbox') {
    const checked = radioOptions.querySelectorAll('input[name="q-choice"]:checked');
    if (checked.length === 0) {
      log('Выберите хотя бы один вариант', 'warn');
      return;
    }
    const values = Array.from(checked).map(cb => cb.value);
    const openTa = document.getElementById('openAnswerText');
    const openText = (values.includes('open') && openTa) ? openTa.value.trim() : '';
    chrome.runtime.sendMessage({ action: 'question-answer', source: 'user', answer: values, openText });
    hideQuestionSection();
    log('Варианты выбраны (пользователем)', 'ok');
  } else {
    const answer = userAnswer.value.trim();
    if (!answer) {
      log('Введите ответ', 'warn');
      return;
    }
    chrome.runtime.sendMessage({ action: 'question-answer', source: 'user', answer });
    hideQuestionSection();
    log('Ответ отправлен (пользовательский)', 'ok');
  }
});

btnLlmAnswer.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'question-answer', source: 'llm' });
  hideQuestionSection();
  log('LLM генерирует ответ...', 'info');
});

btnSkip.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'question-answer', source: 'skip' });
  hideQuestionSection();
  log('Вакансия пропущена', 'warn');
});

btnUseSuggested.addEventListener('click', () => {
  if (currentSuggestedAnswer) {
    chrome.runtime.sendMessage({ action: 'question-answer', source: 'suggested', answer: currentSuggestedAnswer });
    hideQuestionSection();
    log('Используется ответ из базы', 'ok');
  }
});

// --- Дедупликация ---
btnDeduplicate.addEventListener('click', () => {
  const model = getModel();
  const provider = providerSelect.value;
  log('Запуск дедупликации...', 'info');
  btnDeduplicate.disabled = true;
  chrome.runtime.sendMessage({ action: 'deduplicate', model, provider }, () => {
    btnDeduplicate.disabled = false;
    loadQALog();
  });
});

// --- Загрузка базы ответов ---
function loadQALog() {
  chrome.storage.local.get(['qaCondensed', 'qaHistory'], (data) => {
    qaLog.innerHTML = '';
    const source = data.qaCondensed ? 'qaCondensed' : 'qaHistory';
    const items = data[source] || [];
    if (items.length === 0) {
      qaLog.textContent = 'Пока нет сохранённых ответов';
      return;
    }
    items.forEach((item, i) => {
      const div = document.createElement('div');
      div.style.borderBottom = '1px solid #1a1a2e';
      div.style.padding = '4px 0';
      div.style.position = 'relative';
      div.innerHTML = `<span style="color:#ff9800">Q:</span> ${item.question}<br><span style="color:#4caf50">A:</span> ${item.answer}`;
      const delBtn = document.createElement('span');
      delBtn.textContent = '\u2716';
      delBtn.title = 'Удалить';
      delBtn.style.cssText = 'position:absolute;top:4px;right:4px;cursor:pointer;color:#e74c3c;font-size:13px;opacity:0.6;';
      delBtn.addEventListener('mouseenter', () => delBtn.style.opacity = '1');
      delBtn.addEventListener('mouseleave', () => delBtn.style.opacity = '0.6');
      delBtn.addEventListener('click', () => deleteQAItem(source, i));
      div.appendChild(delBtn);
      qaLog.appendChild(div);
    });
  });
}

// --- Удаление одного ответа ---
function deleteQAItem(source, index) {
  chrome.storage.local.get([source], (data) => {
    const items = data[source] || [];
    items.splice(index, 1);
    chrome.storage.local.set({ [source]: items }, () => loadQALog());
  });
}

// --- Очистить всю базу ---
btnClearQA.addEventListener('click', () => {
  if (!confirm('Удалить все сохранённые ответы?')) return;
  chrome.storage.local.remove(['qaHistory', 'qaCondensed'], () => {
    log('База ответов очищена', 'ok');
    loadQALog();
  });
});

// --- Keep-alive: держим service worker живым ---
const keepAlivePort = chrome.runtime.connect({ name: 'keep-alive' });
keepAlivePort.onMessage.addListener(() => {}); // получаем пинги

// --- При открытии popup ---
chrome.runtime.sendMessage({ action: 'popup-ready' });
loadQALog();
