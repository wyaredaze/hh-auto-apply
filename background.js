// Оркестратор: управляет навигацией и инжектирует content script на каждой странице.
// Content script работает только с DOM текущей страницы.

let stopped = false;
let pendingQuestionResolve = null;
let currentPendingQuestion = null;
let currentApiKey = '';
let currentBaseUrl = '';
let currentAutoAction = 'none'; // 'none' | 'llm' | 'skip'
let currentAutoTimeout = 20;
let currentDbConfirm = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Пауза на вопросе: ждём ответ от пользователя через popup ---
function waitForUserAnswer(questionData) {
  const action = currentAutoAction; // 'none' | 'llm' | 'skip'

  // Таймаут 0 — выполнить сразу без паузы
  if (action !== 'none' && currentAutoTimeout === 0) {
    // Если есть ответ из базы — используем его вместо LLM
    if (action === 'llm' && questionData.suggestedAnswer && questionData.suggestedSource === 'db') {
      forwardToPopup({ type: 'log', text: 'Авто-ответ из базы (без ожидания)', level: 'ok' });
      return Promise.resolve({ source: 'suggested', answer: questionData.suggestedAnswer });
    }
    forwardToPopup({ type: 'log', text: action === 'llm' ? 'Авто-ответ LLM (без ожидания)' : 'Авто-пропуск вакансии (без ожидания)', level: 'info' });
    return Promise.resolve({ source: action });
  }

  currentPendingQuestion = questionData;
  forwardToPopup({ type: 'question-pause', ...questionData });

  return new Promise((resolve) => {
    pendingQuestionResolve = resolve;

    // Keepalive: не даём Chrome убить service worker
    const keepalive = setInterval(() => {
      chrome.storage.local.get('_keepalive');
    }, 25000);

    // Таймаут: только если выбрано авто-действие
    let timeout = null;
    if (action !== 'none') {
      const timeoutMs = currentAutoTimeout * 1000;
      timeout = setTimeout(() => {
        clearInterval(keepalive);
        pendingQuestionResolve = null;
        currentPendingQuestion = null;
        // Если есть ответ из базы — используем его вместо LLM
        if (action === 'llm' && questionData.suggestedAnswer && questionData.suggestedSource === 'db') {
          forwardToPopup({ type: 'log', text: `Авто-ответ из базы (таймаут ${currentAutoTimeout}с)`, level: 'ok' });
          forwardToPopup({ type: 'question-done' });
          resolve({ source: 'suggested', answer: questionData.suggestedAnswer });
        } else {
          const label = action === 'llm' ? 'Авто-ответ LLM' : 'Авто-пропуск вакансии';
          forwardToPopup({ type: 'log', text: `${label} (таймаут ${currentAutoTimeout}с)`, level: 'info' });
          forwardToPopup({ type: 'question-done' });
          resolve({ source: action });
        }
      }, timeoutMs);
    }

    // Оборачиваем resolve, чтобы очистить таймеры
    const originalResolve = resolve;
    pendingQuestionResolve = (result) => {
      clearInterval(keepalive);
      if (timeout) clearTimeout(timeout);
      pendingQuestionResolve = null;
      currentPendingQuestion = null;
      originalResolve(result);
    };
  });
}

// --- Поиск подходящего ответа в базе через LLM ---
async function findMatchingAnswer(question, model, provider) {
  const data = await chrome.storage.local.get('qaCondensed');
  const condensed = data.qaCondensed;
  if (!condensed || condensed.length === 0) return null;

  const numbered = condensed.map((item, i) => `${i + 1}. Q: ${item.question}\n   A: ${item.answer}`).join('\n');
  const prompt = `Вот база ранее данных ответов:\n${numbered}\n\nНовый вопрос: "${question}"\n\nВерни номер ТОЛЬКО если вопрос из базы спрашивает ПО СУТИ ТО ЖЕ САМОЕ (тот же смысл, та же тема, тот же аспект). Похожие слова или общая тематика — НЕ достаточно. Ответ должен ТОЧНО подходить как ответ на новый вопрос.\n\nВАЖНО: "опыт с X" и "опыт с Y" — это РАЗНЫЕ вопросы если X и Y разные технологии/языки. Например "опыт с Go" и "опыт с Kotlin" — это разные вопросы, ответ НЕ подходит.\n\nЕсли подходит — верни ТОЛЬКО номер (число). Если нет — верни ТОЛЬКО слово НЕТ. Без пояснений.`;

  try {
    const result = await askLLM(prompt, model, provider);
    const num = parseInt(result.trim(), 10);
    if (!isNaN(num) && num >= 1 && num <= condensed.length) {
      return condensed[num - 1].answer;
    }
  } catch (e) {
    // Ошибка поиска — не критично, продолжаем без suggestion
  }
  return null;
}

// --- Сохранение пары вопрос-ответ ---
async function saveQA(question, answer, vacancyTitle) {
  const data = await chrome.storage.local.get('qaHistory');
  const history = data.qaHistory || [];
  history.push({ question, answer, vacancyTitle, timestamp: Date.now() });
  // FIFO: максимум 200
  while (history.length > 200) history.shift();
  await chrome.storage.local.set({ qaHistory: history });
  forwardToPopup({ type: 'qa-updated' });
}

// --- Программный матчинг резюме и вакансии ---
function findMatches(resumeText, vacancyText) {
  const STOP_WORDS = new Set([
    'и', 'в', 'на', 'с', 'по', 'для', 'от', 'из', 'до', 'не', 'за', 'что', 'как', 'или',
    'это', 'так', 'все', 'при', 'уже', 'его', 'мы', 'вы', 'они', 'она', 'он', 'быть',
    'также', 'более', 'будет', 'есть', 'было', 'были', 'был', 'может', 'нет', 'между',
    'через', 'после', 'перед', 'под', 'над', 'без', 'про', 'обо', 'около',
    'опыт', 'работа', 'работы', 'знание', 'знания', 'умение', 'навыки', 'навык',
    'года', 'лет', 'год', 'месяцев', 'понимание', 'использование', 'владение',
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'will', 'has', 'have',
    'experience', 'years', 'work', 'working', 'knowledge', 'skills', 'using', 'ability'
  ]);

  function extractWords(text) {
    return text.toLowerCase()
      .replace(/[()\/\\\[\]{}<>|,;:!?"""''«»—–\-\.]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  }

  // Извлекаем биграммы для составных терминов (напр. "clean architecture", "code review")
  function extractBigrams(text) {
    const words = extractWords(text);
    const bigrams = [];
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.push(words[i] + ' ' + words[i + 1]);
    }
    return bigrams;
  }

  const resumeWords = new Set(extractWords(resumeText));
  const vacancyWords = extractWords(vacancyText);
  const resumeBigrams = new Set(extractBigrams(resumeText));
  const vacancyBigrams = extractBigrams(vacancyText);

  const matches = new Set();

  // Совпадения по биграммам (приоритет)
  for (const bg of vacancyBigrams) {
    if (resumeBigrams.has(bg)) matches.add(bg);
  }

  // Совпадения по словам
  for (const w of vacancyWords) {
    if (resumeWords.has(w)) matches.add(w);
  }

  return [...matches];
}

// --- Быстрая локальная дедупликация (без LLM) ---
function normalizeQuestion(q) {
  return q.toLowerCase().replace(/[^а-яa-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function deduplicateQALocal() {
  const data = await chrome.storage.local.get(['qaHistory', 'qaCondensed']);
  const history = data.qaHistory || [];
  if (history.length === 0) return;

  // Объединяем с существующей condensed базой
  const existing = data.qaCondensed || [];
  const all = [...existing, ...history.map(h => ({ question: h.question, answer: h.answer }))];

  // Дедупликация по нормализованному вопросу (оставляем последний ответ)
  const seen = new Map();
  for (const item of all) {
    const key = normalizeQuestion(item.question);
    seen.set(key, item);
  }
  const condensed = Array.from(seen.values());

  await chrome.storage.local.set({ qaCondensed: condensed });
  await chrome.storage.local.remove('qaHistory');

  const removed = all.length - condensed.length;
  if (removed > 0) {
    forwardToPopup({ type: 'log', text: `Дедупликация: убрано ${removed} дублей (${condensed.length} записей)`, level: 'ok' });
  }
}

// --- Умная дедупликация через LLM (для ручного вызова) ---
async function deduplicateQAWithLLM(model, provider) {
  const data = await chrome.storage.local.get(['qaHistory', 'qaCondensed']);
  const history = data.qaHistory || [];
  const existing = data.qaCondensed || [];
  const all = [...existing, ...history.map(h => ({ question: h.question, answer: h.answer }))];
  if (all.length === 0) return;

  const items = all.map((item, i) => `${i + 1}. Q: ${item.question}\n   A: ${item.answer}`).join('\n');
  const prompt = `Вот список пар вопрос-ответ. Убери дубликаты и объедини похожие вопросы (оставь лучший ответ). Верни результат ТОЛЬКО как JSON массив объектов с полями "question" и "answer". Без пояснений, только JSON.\n\n${items}`;

  try {
    const result = await askLLM(prompt, model, provider);
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const condensed = JSON.parse(jsonMatch[0]);
      await chrome.storage.local.set({ qaCondensed: condensed });
      await chrome.storage.local.remove('qaHistory');
      forwardToPopup({ type: 'log', text: `LLM-дедупликация: ${all.length} → ${condensed.length} записей`, level: 'ok' });
      forwardToPopup({ type: 'qa-updated' });
      return condensed;
    }
  } catch (e) {
    forwardToPopup({ type: 'log', text: `Ошибка LLM-дедупликации: ${e.message}`, level: 'err' });
  }
  return null;
}

// Инжектировать content.js и дождаться готовности
async function injectAndWait(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
  // Даём скрипту время инициализироваться
  await sleep(500);
}

// Отправить сообщение content script и получить ответ (с автопереинжектом)
async function sendToContent(tabId, msg, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, msg, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      return response;
    } catch (e) {
      if (attempt < retries && e.message.includes('Could not establish connection')) {
        console.warn(`[sendToContent] Content script lost, re-injecting (attempt ${attempt})`);
        await injectAndWait(tabId);
        continue;
      }
      throw e;
    }
  }
}

// Навигация и ожидание загрузки
function navigateAndWait(tabId, url) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

// Ожидание возможной навигации после клика (если страница не навигировала — возвращается быстро)
function waitForPossibleNavigation(tabId, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let navigated = false;
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        navigated = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    sleep(timeoutMs).then(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (!navigated) resolve(false);
    });
  });
}

// Пересылка логов и прогресса в popup
function forwardToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // popup может быть закрыт — ок
  });
}

// --- Главный цикл ---
async function run(tabId, resumeText, model, blacklist, provider, apiKey, baseUrl, autoAction, autoTimeout, dbConfirm) {
  stopped = false;
  currentApiKey = apiKey || '';
  currentBaseUrl = baseUrl || '';
  currentAutoAction = autoAction || 'none';
  currentAutoTimeout = autoTimeout || 20;
  currentDbConfirm = !!dbConfirm;
  forwardToPopup({ type: 'log', text: `[CFG] autoAction=${currentAutoAction}, timeout=${currentAutoTimeout}, dbConfirm=${currentDbConfirm}`, level: 'info' });

  // 1. Собираем вакансии со страницы поиска
  await injectAndWait(tabId);
  const vacancies = await sendToContent(tabId, { action: 'collectVacancies' });

  if (!vacancies || vacancies.length === 0) {
    forwardToPopup({ type: 'log', text: 'Вакансии не найдены на странице', level: 'err' });
    forwardToPopup({ type: 'done' });
    return;
  }

  // Парсим чёрный список
  const blacklistWords = blacklist
    ? blacklist.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean)
    : [];

  // Фильтруем по названию
  const filtered = blacklistWords.length > 0
    ? vacancies.filter((v) => {
        const titleLower = v.title.toLowerCase();
        const blocked = blacklistWords.find((w) => titleLower.includes(w));
        if (blocked) {
          forwardToPopup({ type: 'log', text: `Пропуск (чёрный список "${blocked}"): ${v.title}`, level: 'warn' });
        }
        return !blocked;
      })
    : vacancies;

  forwardToPopup({ type: 'log', text: `Найдено ${vacancies.length} вакансий` + (filtered.length < vacancies.length ? `, после фильтра: ${filtered.length}` : ''), level: 'info' });
  forwardToPopup({ type: 'progress', sent: 0, total: filtered.length });

  const searchUrl = (await chrome.tabs.get(tabId)).url;
  let sent = 0;

  for (let i = 0; i < filtered.length; i++) {
    if (stopped) {
      forwardToPopup({ type: 'log', text: 'Остановлено', level: 'warn' });
      break;
    }

    const vacancy = filtered[i];
    forwardToPopup({ type: 'log', text: `[${i + 1}/${filtered.length}] ${vacancy.title}`, level: 'info' });

    let hadQuestions = false;
    try {
      // Переходим на страницу вакансии
      await navigateAndWait(tabId, vacancy.url);
      await sleep(1500);

      // Инжектим content script
      await injectAndWait(tabId);

      // Читаем описание и кликаем "Откликнуться"
      const vacancyInfo = await sendToContent(tabId, { action: 'getVacancyInfo' });

      if (!vacancyInfo.canApply) {
        forwardToPopup({ type: 'log', text: `Пропуск: ${vacancyInfo.reason}`, level: 'warn' });
        forwardToPopup({ type: 'progress', sent, total: filtered.length });
        continue;
      }

      // Проверка описания по чёрному списку
      if (blacklistWords.length > 0 && vacancyInfo.description) {
        const descLower = vacancyInfo.description.toLowerCase();
        const blocked = blacklistWords.find((w) => descLower.includes(w));
        if (blocked) {
          forwardToPopup({ type: 'log', text: `Пропуск по описанию (чёрный список "${blocked}")`, level: 'warn' });
          forwardToPopup({ type: 'progress', sent, total: filtered.length });
          continue;
        }
      }

      // Сжимаем описание вакансии через LLM
      if (vacancyInfo.description) {
        forwardToPopup({ type: 'log', text: 'Сжимаю описание вакансии...', level: 'info' });
        try {
          const compressedDesc = await askLLM(`Сожми описание вакансии в короткий plain text. Без markdown. Каждый раздел с новой строки.

Формат:
Позиция: [название]
Задачи: [все обязанности через запятую]
Требования: [языки, технологии, опыт, навыки — через запятую]
Плюсом: [если есть — через запятую]

Убери: описание компании, условия работы, бенефиты, воду.

ВАКАНСИЯ:
${vacancyInfo.description}`, model, provider);
          vacancyInfo.description = compressedDesc;
          forwardToPopup({ type: 'log', text: `Вакансия сжата (${compressedDesc.length} сим.)`, level: 'ok' });
          forwardToPopup({ type: 'debug-vacancy', title: vacancyInfo.title, text: compressedDesc });
        } catch (e) {
          forwardToPopup({ type: 'log', text: `Не удалось сжать вакансию: ${e.message}`, level: 'warn' });
        }
      }

      // Если на странице вакансии есть предупреждение о релокации — закрываем его
      const relocationBefore = await sendToContent(tabId, { action: 'dismissRelocationWarning' });
      if (relocationBefore.dismissed) {
        forwardToPopup({ type: 'log', text: 'Подтверждён отклик в другую страну (до отклика)', level: 'info' });
        await sleep(1500);
      }

      // Кликаем "Откликнуться"
      forwardToPopup({ type: 'log', text: 'Нажимаю "Откликнуться"...', level: 'info' });
      await sendToContent(tabId, { action: 'clickApply' });

      // Ждём: страница может навигировать (форма с вопросами) или остаться (модалка)
      const navigated = await waitForPossibleNavigation(tabId, 3000);
      if (navigated) {
        // Страница навигировала — переинжектим content script
        await sleep(2000);
        await injectAndWait(tabId);
      } else {
        // Даже без навигации страница могла обновить DOM — переинжектим на всякий случай
        await sleep(1000);
      }

      // Если вакансия в другой стране — подтверждаем
      const relocation = await sendToContent(tabId, { action: 'dismissRelocationWarning' });
      if (relocation.dismissed) {
        forwardToPopup({ type: 'log', text: 'Подтверждён отклик в другую страну', level: 'info' });
        await sleep(1500);
      }

      // Ждём рендер формы перед сбором данных
      await sleep(2000);
      const formInfo = await sendToContent(tabId, { action: 'getFormInfo' });

      // Генерируем тексты через LLM (в background, без таймаутов)
      forwardToPopup({ type: 'log', text: 'Генерирую тексты через LLM...', level: 'info' });

      const generatedAnswers = [];
      let skipped = false;
      if (formInfo.questions && formInfo.questions.length > 0) {
        hadQuestions = true;
        for (let qi = 0; qi < formInfo.questions.length; qi++) {
          if (stopped || skipped) break;
          const q = formInfo.questions[qi];
          const qText = q.text || q;

          if (q.type === 'radio') {
            // Тестовый вопрос с вариантами ответа
            const optionsText = q.options.map((o, i) => `${i + 1}. ${o.text}`).join('\n');

            // Ищем ответ в базе
            forwardToPopup({ type: 'log', text: `Ищу ответ в базе для: "${qText.substring(0, 50)}..."`, level: 'info' });
            const savedAnswer = await findMatchingAnswer(qText, model, provider);
            if (stopped) break;
            const savedOption = savedAnswer ? q.options.find(o => o.text === savedAnswer) : null;

            let selectedValue;
            if (savedOption) {
              // Ответ из базы совпал с вариантом — используем сразу
              selectedValue = savedOption.value;
              forwardToPopup({ type: 'log', text: `Ответ из базы: "${savedAnswer}"`, level: 'ok' });
            } else {
              // Сначала LLM выбирает ответ
              forwardToPopup({ type: 'log', text: 'LLM выбирает ответ...', level: 'info' });
              const prompt = `Выбери правильный ответ на вопрос. Верни ТОЛЬКО номер правильного ответа (число). Без пояснений.\n\nВОПРОС: ${qText}\n\nВАРИАНТЫ:\n${optionsText}`;
              const llmResult = await askLLM(prompt, model, provider);
              if (stopped) break;
              const llmNum = parseInt(llmResult.trim(), 10);
              const llmSelectedIndex = (!isNaN(llmNum) && llmNum >= 1 && llmNum <= q.options.length) ? llmNum - 1 : 0;
              forwardToPopup({ type: 'log', text: `LLM рекомендует вариант ${llmSelectedIndex + 1}`, level: 'ok' });

              // Показываем пользователю с рекомендацией LLM
              forwardToPopup({ type: 'log', text: 'Ожидаю ответ пользователя (тест)...', level: 'warn' });
              const decision = await waitForUserAnswer({
                question: qText,
                vacancyTitle: vacancy.title,
                questionType: 'radio',
                options: q.options,
                radioName: q.name,
                questionIndex: qi,
                totalQuestions: formInfo.questions.length,
                llmSelectedIndex
              });

              if (decision.source === 'skip') {
                skipped = true;
                forwardToPopup({ type: 'log', text: 'Вакансия пропущена', level: 'warn' });
                break;
              } else if (decision.source === 'user') {
                selectedValue = decision.answer;
                forwardToPopup({ type: 'log', text: 'Выбран вариант пользователем', level: 'ok' });
              } else {
                selectedValue = q.options[llmSelectedIndex].value;
                forwardToPopup({ type: 'log', text: `Используется вариант LLM: ${llmSelectedIndex + 1}`, level: 'ok' });
              }
            }

            const selectedOption = q.options.find(o => o.value === selectedValue);
            const selectedText = selectedOption ? selectedOption.text : selectedValue;
            forwardToPopup({ type: 'debug', vacancy: vacancy.title, question: qText, answer: selectedText });
            await saveQA(qText, selectedText, vacancy.title);
            generatedAnswers.push({ type: 'radio', name: q.name, value: selectedValue });

          } else if (q.type === 'checkbox') {
            // Вопрос с чекбоксами (множественный выбор)
            const optionsText = q.options.map((o, i) => `${i + 1}. ${o.text}`).join('\n');

            // Ищем ответ в базе
            forwardToPopup({ type: 'log', text: `Ищу ответ в базе для: "${qText.substring(0, 50)}..."`, level: 'info' });
            const savedAnswer = await findMatchingAnswer(qText, model, provider);
            if (stopped) break;
            const savedTexts = savedAnswer ? savedAnswer.split(', ').map(s => s.trim()) : [];
            const savedValues = savedTexts.map(t => {
              const opt = q.options.find(o => o.text === t);
              return opt ? opt.value : null;
            }).filter(Boolean);

            let selectedValues, openText;
            if (savedValues.length > 0) {
              // Ответ из базы совпал с вариантами — используем сразу
              selectedValues = savedValues;
              openText = '';
              forwardToPopup({ type: 'log', text: `Ответы из базы: "${savedAnswer}"`, level: 'ok' });
            } else {
              // Сначала LLM выбирает
              forwardToPopup({ type: 'log', text: 'LLM выбирает ответы...', level: 'info' });
              const prompt = `Выбери подходящие ответы на вопрос. Может быть один или несколько, но НИКОГДА не выбирай взаимоисключающие варианты (например "Да" и "Нет" одновременно). Верни ТОЛЬКО номера через запятую (например: 1,3). Без пояснений.\n\nВОПРОС: ${qText}\n\nВАРИАНТЫ:\n${optionsText}`;
              const llmResult = await askLLM(prompt, model, provider);
              if (stopped) break;
              const llmNums = llmResult.trim().split(/[,\s]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n >= 1 && n <= q.options.length);
              const llmSelectedIndices = llmNums.length > 0 ? llmNums.map(n => n - 1) : [0];
              forwardToPopup({ type: 'log', text: `LLM рекомендует варианты: ${llmNums.join(', ')}`, level: 'ok' });

              // Показываем пользователю с рекомендацией LLM
              forwardToPopup({ type: 'log', text: 'Ожидаю ответ пользователя (множественный выбор)...', level: 'warn' });
              const decision = await waitForUserAnswer({
                question: qText,
                vacancyTitle: vacancy.title,
                questionType: 'checkbox',
                options: q.options,
                checkboxName: q.name,
                questionIndex: qi,
                totalQuestions: formInfo.questions.length,
                llmSelectedIndices
              });

              if (decision.source === 'skip') {
                skipped = true;
                forwardToPopup({ type: 'log', text: 'Вакансия пропущена', level: 'warn' });
                break;
              } else if (decision.source === 'user') {
                selectedValues = decision.answer;
                openText = decision.openText || '';
                forwardToPopup({ type: 'log', text: 'Выбраны варианты пользователем', level: 'ok' });
              } else {
                selectedValues = llmSelectedIndices.map(i => q.options[i].value);
                openText = '';
                forwardToPopup({ type: 'log', text: `Используются варианты LLM: ${llmNums.join(', ')}`, level: 'ok' });
              }
            }

            const selectedTexts = selectedValues.map(v => {
              const opt = q.options.find(o => o.value === v);
              return opt ? opt.text : v;
            }).join(', ');
            forwardToPopup({ type: 'debug', vacancy: vacancy.title, question: qText, answer: selectedTexts });
            await saveQA(qText, selectedTexts, vacancy.title);
            generatedAnswers.push({ type: 'checkbox', name: q.name, values: selectedValues, openText });

          } else {
            // Текстовый вопрос
            // Ищем подходящий ответ в базе
            forwardToPopup({ type: 'log', text: `Ищу ответ в базе для: "${qText.substring(0, 50)}..."`, level: 'info' });
            const suggestedAnswer = await findMatchingAnswer(qText, model, provider);
            if (stopped) break;
            forwardToPopup({ type: 'log', text: suggestedAnswer ? `Найден в базе: "${suggestedAnswer.substring(0, 40)}..."` : 'В базе не найден', level: suggestedAnswer ? 'ok' : 'info' });

            let answer;
            if (suggestedAnswer && !currentDbConfirm) {
              // Ответ найден в базе — используем сразу
              answer = suggestedAnswer;
              forwardToPopup({ type: 'log', text: `Ответ из базы: "${answer.substring(0, 50)}..."`, level: 'ok' });
            } else if (suggestedAnswer && currentDbConfirm) {
              // Ответ найден в базе — показываем пользователю для подтверждения
              forwardToPopup({ type: 'log', text: `[ДИАЛОГ] Подтверждение ответа из базы ${qi + 1}/${formInfo.questions.length}`, level: 'warn' });
              const decision = await waitForUserAnswer({
                question: qText,
                vacancyTitle: vacancy.title,
                questionType: 'text',
                suggestedAnswer,
                suggestedSource: 'db',
                questionIndex: qi,
                totalQuestions: formInfo.questions.length
              });

              if (decision.source === 'skip') {
                skipped = true;
                forwardToPopup({ type: 'log', text: 'Вакансия пропущена', level: 'warn' });
                break;
              } else if (decision.source === 'user') {
                answer = decision.answer;
                forwardToPopup({ type: 'log', text: 'Используется ответ пользователя', level: 'ok' });
              } else {
                answer = decision.answer || suggestedAnswer;
                forwardToPopup({ type: 'log', text: 'Ответ из базы подтверждён', level: 'ok' });
              }
            } else {
              // Нет в базе — сначала генерируем LLM-ответ, потом показываем пользователю
              forwardToPopup({ type: 'log', text: 'Генерирую ответ через LLM...', level: 'info' });
              const prompt = `Ты — кандидат, который отвечает на вопрос работодателя при отклике на вакансию.

Упоминай только опыт и технологии из резюме. Если технологии нет в резюме — скажи честно и упомяни похожий опыт или готовность разобраться.

Теоретические вопросы ("Что такое X?", "Как работает Y?") — отвечай развёрнуто как специалист (3-5 предложений).

Плохо: "Имею 7 лет коммерческого опыта в разработке backend-систем на PHP"
Хорошо: "7 лет пишу на PHP, последние 3 — Symfony на highload"

Плохо: "Обладаю обширным опытом работы с реляционными СУБД"
Хорошо: "Работаю с PostgreSQL каждый день, в прошлом проекте оптимизировал тяжёлые запросы через explain analyze"

Примеры ответов:

В: "Опыт с Kubernetes?"
О: Да, на двух проектах настраивал кластеры и Helm-чарты, деплой шёл через GitLab CI.

В: "Знаете Flutter?"
О: С Flutter не работал, но писал API для мобильных приложений — думаю, разберусь быстро.

В: "Что такое индекс в БД?"
О: Индекс — структура данных, которая ускоряет поиск по таблице, примерно как алфавитный указатель в книге. Бывают B-tree, hash, GIN, GiST — каждый под свои задачи. B-tree подходит для сортировок и диапазонов, GIN — для полнотекстового поиска и jsonb. Минус — индексы замедляют запись и занимают место, поэтому создавать их нужно по реальным запросам.

Пиши от первого лица. Кратко (1-3 предложения). Без предисловий вроде "На основе резюме..." или "Исходя из моего опыта...".

РЕЗЮМЕ:
${resumeText}

ВОПРОС:
${qText}`;
              const llmAnswer = await askLLM(prompt, model, provider);
              if (stopped) break;
              forwardToPopup({ type: 'log', text: `LLM ответ готов`, level: 'ok' });

              // Показываем пользователю вопрос с LLM-ответом
              forwardToPopup({ type: 'log', text: `[ДИАЛОГ] Показываю вопрос ${qi + 1}/${formInfo.questions.length}`, level: 'warn' });
              const decision = await waitForUserAnswer({
                question: qText,
                vacancyTitle: vacancy.title,
                questionType: 'text',
                suggestedAnswer: llmAnswer,
                suggestedSource: 'llm',
                questionIndex: qi,
                totalQuestions: formInfo.questions.length
              });

              if (decision.source === 'skip') {
                skipped = true;
                forwardToPopup({ type: 'log', text: 'Вакансия пропущена', level: 'warn' });
                break;
              } else if (decision.source === 'user') {
                answer = decision.answer;
                forwardToPopup({ type: 'log', text: 'Используется ответ пользователя', level: 'ok' });
              } else {
                // source === 'llm' или 'suggested' — используем уже сгенерированный
                answer = decision.answer || llmAnswer;
                forwardToPopup({ type: 'log', text: 'Используется ответ LLM', level: 'ok' });
              }
            }

            forwardToPopup({ type: 'debug', vacancy: vacancy.title, question: qText, answer });
            await saveQA(qText, answer, vacancy.title);
            generatedAnswers.push({ type: 'text', value: answer, _fromDb: !!suggestedAnswer });
          }
        }
      }

      if (skipped || stopped) {
        forwardToPopup({ type: 'progress', sent, total: filtered.length });
        continue;
      }

      const matches = findMatches(resumeText, vacancyInfo.description || '');
      const matchesHint = matches.length > 0
        ? `\nСОВПАДЕНИЯ между резюме и вакансией (используй ИХ в первую очередь): ${matches.join(', ')}\n`
        : '\nСовпадений по ключевым словам не найдено — покажи общий релевантный опыт.\n';
      forwardToPopup({ type: 'log', text: `Матчинг: ${matches.length} совпадений`, level: 'info' });
      forwardToPopup({ type: 'debug-vacancy', title: `Матчинг: ${vacancyInfo.title}`, text: matches.length > 0 ? matches.join(', ') : 'совпадений не найдено' });

      const coverLetterPrompt = `Напиши короткий отклик на вакансию от лица разработчика. Стиль — как сообщение коллеге, не как официальное письмо.
${matchesHint}

Правила:
- Бери факты только из резюме. Не упоминай технологии, которых нет в резюме. Не приписывай роли, которых не было.
- Строй письмо вокруг СОВПАДЕНИЙ (см. выше). Упомяни как можно больше из них. Не заменяй совпадения другими фактами из резюме.
- Бери факты из РАЗНЫХ мест работы, не только из последнего.
- Если совпадений нет или главный стек вакансии отсутствует в резюме — честно скажи что опыта с ним нет, но покажи похожий опыт и готовность освоить.
- Не комментируй вакансию ("интересное направление", "задачи выглядят интересными").
- Короткие предложения. Без канцелярита.

Не используй фразы: "Имею X лет опыта", "Меня заинтересовала позиция", "коммерческий опыт", "Обладаю навыками", "Готов обсудить детали", "Готов рассказать подробнее", "интересное направление", "выглядят интересными".

Напиши ОДИН отклик. Выбери один из подходов к началу:
- С конкретной задачи из вакансии
- С достижения на прошлом месте
- С совпадения по стеку или нише

Выведи только текст письма и контакты, без заголовков, вариантов и пояснений.

Формат:
- Начни с приветствия (Приветствую! / Добрый день! / Здравствуйте!)
- 2-3 предложения
- Призыв к сотрудничеству (например: "Буду рад пообщаться!", "Напишите, обсудим!", "С удовольствием расскажу подробнее!")
- Пустая строка
- Контакты из резюме (каждый с новой строки, без заголовка)

Примеры:

Приветствую!
Вам нужен Go-разработчик с опытом в микросервисах — в Zaymigo я проектировал микросервисную архитектуру и настраивал инфраструктуру на Kubernetes с Helm. Kafka и PostgreSQL тоже в моём стеке. Буду рад пообщаться!

+7 (912) 3456789
ivan.dev@gmail.com
telegram: @ivandev

Добрый день!
Вижу, что нужен человек для интеграций с внешними сервисами — в Code Pilots я интегрировал платёжные системы и сторонние API, а в Zaymigo разрабатывал API для мобильного приложения. Напишите, обсудим!

anna.k@yandex.ru
+7 (903) 7654321

Здравствуйте!
В описании вакансии акцент на PHP и проектирование архитектуры — работаю с PHP 7 лет, на Symfony и Laravel, в последнем проекте проектировал DDD/CQRS архитектуру. С удовольствием расскажу подробнее!

telegram: @sergey_go
sergey@mail.ru

ВАКАНСИЯ: ${vacancyInfo.title}${vacancyInfo.company ? ' в ' + vacancyInfo.company : ''}
${vacancyInfo.description}

РЕЗЮМЕ:
${resumeText}`;
      const coverLetter = await askLLM(coverLetterPrompt, model, provider);

      if (stopped) continue;

      // Отправляем готовые тексты в content script для заполнения
      const fromDb = generatedAnswers.filter(a => a._fromDb).length;
      forwardToPopup({ type: 'log', text: `Заполняю форму: ${generatedAnswers.length} ответов (из базы: ${fromDb}, вопросов в форме: ${formInfo.questions ? formInfo.questions.length : 0})`, level: 'info' });
      try {
        const result = await sendToContent(tabId, {
          action: 'fillAndSubmit',
          answers: generatedAnswers,
          coverLetter
        });

        if (result.success) {
          sent++;
          forwardToPopup({ type: 'log', text: `Отклик отправлен!`, level: 'ok' });
        } else {
          forwardToPopup({ type: 'log', text: `Ошибка: ${result.error}`, level: 'err' });
        }
      } catch (submitErr) {
        // Если страница навигировала после отправки — скорее всего отклик прошёл
        if (submitErr.message.includes('message channel closed') || submitErr.message.includes('Could not establish connection')) {
          sent++;
          forwardToPopup({ type: 'log', text: `Отклик отправлен (страница навигировала)`, level: 'ok' });
        } else {
          forwardToPopup({ type: 'log', text: `Ошибка отправки: ${submitErr.message}`, level: 'err' });
        }
      }
    } catch (e) {
      forwardToPopup({ type: 'log', text: `Ошибка: ${e.message}`, level: 'err' });
      if (e.message && (e.message.includes('недоступна') || e.message.includes('HTTP 401') || e.message.includes('HTTP 403'))) {
        forwardToPopup({ type: 'log', text: 'LLM недоступна — останавливаю', level: 'err' });
        break;
      }
    }

    forwardToPopup({ type: 'progress', sent, total: filtered.length });

    // Дедупликация после отклика, если были вопросы
    if (hadQuestions) {
      try {
        forwardToPopup({ type: 'log', text: 'Дедупликация базы...', level: 'info' });
        await deduplicateQAWithLLM(model, provider);
      } catch (e) {
        forwardToPopup({ type: 'log', text: `Дедупликация пропущена: ${e.message}`, level: 'warn' });
      }
    }

    // Возвращаемся на страницу поиска
    if (i < filtered.length - 1 && !stopped) {
      await navigateAndWait(tabId, searchUrl);
      await sleep(1500);
    }
  }

  forwardToPopup({ type: 'log', text: `Завершено. Отправлено ${sent} из ${filtered.length}`, level: 'ok' });
  forwardToPopup({ type: 'done' });
}

// --- LLM API со streaming ---
const PROVIDER_CONFIG = {
  ollama: {
    name: 'Ollama',
    getUrl: (baseUrl) => `${baseUrl || 'http://localhost:11434'}/api/generate`,
    buildBody: (model, prompt) => ({ model, prompt, stream: true, think: false }),
    readStream: 'ollama',
    needsKey: false
  },
  lmstudio: {
    name: 'LM Studio',
    getUrl: (baseUrl) => `${baseUrl || 'http://localhost:1234'}/v1/chat/completions`,
    buildBody: (model, prompt) => ({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
    readStream: 'sse',
    needsKey: false
  },
  openai: {
    name: 'OpenAI',
    getUrl: () => 'https://api.openai.com/v1/chat/completions',
    buildBody: (model, prompt) => ({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
    readStream: 'sse',
    needsKey: true
  },
  claude: {
    name: 'Claude',
    getUrl: () => 'https://api.anthropic.com/v1/messages',
    buildBody: (model, prompt) => ({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096, stream: true }),
    readStream: 'claude',
    needsKey: true
  }
};

async function askLLM(prompt, model, provider = 'ollama', retries = 3) {
  const cfg = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.ollama;
  const headers = { 'Content-Type': 'application/json' };

  if (cfg.needsKey && currentApiKey) {
    if (provider === 'claude') {
      headers['x-api-key'] = currentApiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
      headers['Authorization'] = `Bearer ${currentApiKey}`;
    }
  }

  const body = cfg.buildBody(model, prompt);

  for (let attempt = 1; attempt <= retries; attempt++) {
    let resp;
    try {
      resp = await fetch(cfg.getUrl(currentBaseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (attempt < retries) {
        forwardToPopup({ type: 'log', text: `${cfg.name} сетевая ошибка: ${e.message}, повтор ${attempt}/${retries}...`, level: 'warn' });
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`${cfg.name} недоступна: ${e.message}`);
    }
    if (resp.status >= 500) {
      console.warn(`[askLLM] ${cfg.name} HTTP ${resp.status}, attempt ${attempt}/${retries}`);
      if (attempt < retries) {
        forwardToPopup({ type: 'log', text: `${cfg.name} ошибка ${resp.status}, повтор ${attempt}/${retries}...`, level: 'warn' });
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`${cfg.name} HTTP ${resp.status}`);
    }
    if (!resp.ok) {
      let errMsg = `${cfg.name} HTTP ${resp.status}`;
      try { const errBody = await resp.json(); errMsg += `: ${errBody.error?.message || JSON.stringify(errBody)}`; } catch {}
      throw new Error(errMsg);
    }

    let raw;
    if (cfg.readStream === 'ollama') raw = await readStreamOllama(resp);
    else if (cfg.readStream === 'claude') raw = await readStreamClaude(resp);
    else raw = await readStreamSSE(resp);

    return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
}

// Чтение streaming от Ollama (ndjson: каждая строка — JSON с полем "response")
async function readStreamOllama(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.response) result += obj.response;
      } catch {}
    }
  }
  return result;
}

// Чтение SSE streaming (OpenAI-совместимый: LM Studio, OpenAI)
async function readStreamSSE(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return result;
      try {
        const obj = JSON.parse(data);
        const content = obj.choices?.[0]?.delta?.content;
        if (content) result += content;
      } catch {}
    }
  }
  return result;
}

// Чтение SSE streaming от Claude API
async function readStreamClaude(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      try {
        const obj = JSON.parse(data);
        if (obj.type === 'content_block_delta' && obj.delta?.text) {
          result += obj.delta.text;
        }
      } catch {}
    }
  }
  return result;
}

// --- Открытие side panel по клику на иконку ---
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// --- Keep-alive: popup держит service worker живым через port ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keep-alive') {
    // Пингуем каждые 25 секунд чтобы service worker не засыпал
    const interval = setInterval(() => {
      try { port.postMessage({ ping: true }); } catch { clearInterval(interval); }
    }, 25000);
    port.onDisconnect.addListener(() => clearInterval(interval));
  }
});

// --- Обработка сообщений ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') {
    run(msg.tabId, msg.resumeText, msg.model, msg.blacklist || '', msg.provider || 'ollama', msg.apiKey || '', msg.baseUrl || '', msg.autoAction, msg.autoTimeout, msg.dbConfirm);
    sendResponse({ ok: true });
  }
  if (msg.action === 'stop') {
    stopped = true;
    // Если ждём ответа — отменяем ожидание
    if (pendingQuestionResolve) {
      pendingQuestionResolve({ source: 'llm' });
    }
    sendResponse({ ok: true });
  }

  if (msg.action === 'question-answer') {
    if (pendingQuestionResolve) {
      pendingQuestionResolve({ source: msg.source, answer: msg.answer });
    }
    sendResponse({ ok: true });
  }

  if (msg.action === 'compress-resume') {
    const { resumeText, model, provider, apiKey, baseUrl } = msg;
    currentApiKey = apiKey || '';
    currentBaseUrl = baseUrl || '';
    const prompt = `Сожми резюме в максимально короткий plain text. Без markdown, без звёздочек, без буллетов.

Сохрани:
1. ФИО, возраст, город, гражданство, контакты (сохрани оригинальный формат: телефон с пробелами, telegram: с префиксом), формат работы, желаемую должность — одной строкой
2. Каждое место работы одной строкой: компания (период), должность — 1-2 главных достижения с цифрами
3. Полный список технологий через запятую
4. Образование, языки
5. Раздел "обо мне" — сожми до 1-2 предложений

Убери повторы и воду. Описание каждой работы — максимум 1-2 предложения, только ключевые достижения.

Пример формата:
Иванов Иван, 30 лет, Москва, РФ, +7 (999) 123-45-67, ivan@mail.ru, telegram: @ivan, удалённо/гибрид, Backend developer.
Компания А (2022-2024), Backend — оптимизировал API до 50k RPS, внедрил Kafka.
Компания Б (2020-2022), Backend — разработал микросервисную платформу.
Технологии: Go, PHP, PostgreSQL, Redis, Kafka, Docker, Kubernetes.
Образование: высшее. Языки: русский, английский B1.
7 лет в backend, специализация на highload в fintech и e-commerce.

РЕЗЮМЕ:
${resumeText}`;
    askLLM(prompt, model, provider).then(compressed => {
      sendResponse({ ok: true, compressed });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true; // async sendResponse
  }

  if (msg.action === 'health-check') {
    const provider = msg.provider;
    const apiKey = msg.apiKey || '';
    const baseUrl = msg.baseUrl || '';
    let url, headers = {};

    if (provider === 'openai') {
      url = 'https://api.openai.com/v1/models';
      headers = { 'Authorization': `Bearer ${apiKey}` };
    } else if (provider === 'claude') {
      url = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    } else if (provider === 'lmstudio') {
      url = `${baseUrl || 'http://localhost:1234'}/v1/models`;
    } else {
      url = `${baseUrl || 'http://localhost:11434'}/api/tags`;
    }

    fetch(url, { headers }).then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      sendResponse({ ok: true });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }

  if (msg.action === 'list-models') {
    const provider = msg.provider;
    const apiKey = msg.apiKey || '';
    const baseUrl = msg.baseUrl || '';
    let url, headers = {};

    if (provider === 'openai') {
      url = 'https://api.openai.com/v1/models';
      headers = { 'Authorization': `Bearer ${apiKey}` };
    } else if (provider === 'claude') {
      url = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    } else if (provider === 'lmstudio') {
      url = `${baseUrl || 'http://localhost:1234'}/v1/models`;
    } else {
      url = `${baseUrl || 'http://localhost:11434'}/api/tags`;
    }

    fetch(url, { headers }).then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    }).then(data => {
      let models;
      if (provider === 'openai') {
        models = (data.data || []).map(m => m.id).filter(id => id.startsWith('gpt-')).sort();
      } else if (provider === 'claude') {
        models = (data.data || []).map(m => m.id).sort();
      } else if (provider === 'lmstudio') {
        models = (data.data || []).map(m => m.id);
      } else {
        models = (data.models || []).map(m => m.name);
      }
      sendResponse({ ok: true, models });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message, models: [] });
    });
    return true;
  }

  if (msg.action === 'deduplicate') {
    const model = msg.model || 'qwen3:8b';
    deduplicateQAWithLLM(model, msg.provider || 'ollama').then(() => sendResponse({ ok: true }));
    return true; // async response
  }

  if (msg.action === 'popup-ready') {
    // Повторная отправка pending question при reopening popup
    if (currentPendingQuestion) {
      forwardToPopup({ type: 'question-pause', ...currentPendingQuestion });
    }
    sendResponse({ ok: true });
  }

  // Пересылка логов/прогресса от content script в popup
  if (msg.type === 'log' || msg.type === 'progress' || msg.type === 'done') {
    forwardToPopup(msg);
  }
});
