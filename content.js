// Content script: работает только с DOM текущей страницы.
// Навигацией и Ollama управляет background.js.

(() => {
  if (window.__hhAiApplyLoaded) return;
  window.__hhAiApplyLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const delay = () => sleep(rand(500, 1200));

  function waitFor(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Элемент ${selector} не найден`));
      }, timeout);
    });
  }

  function setTextareaValue(textarea, value) {
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    setter.call(textarea, value);
    // Сброс React _valueTracker, иначе React не увидит изменение
    const tracker = textarea._valueTracker;
    if (tracker) tracker.setValue('');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.action === 'collectVacancies') {
      const vacancies = [];
      const seen = new Set();

      // 1. Карточки со страницы поиска
      document.querySelectorAll('div[data-qa="vacancy-serp__vacancy"]').forEach((card) => {
        const link = card.querySelector('a[data-qa="serp-item__title"]');
        const title = card.querySelector('span[data-qa="serp-item__title-text"]');
        if (link && title && !seen.has(link.href)) {
          seen.add(link.href);
          vacancies.push({ url: link.href, title: title.textContent.trim() });
        }
      });

      // 2. Карточки рекомендаций и похожих вакансий
      document.querySelectorAll('[data-qa="vacancy-serp__vacancy_recommended"], [data-qa="vacancy-serp__vacancy_premium"]').forEach((card) => {
        const link = card.querySelector('a[data-qa="serp-item__title"]');
        const title = card.querySelector('span[data-qa="serp-item__title-text"]');
        if (link && title && !seen.has(link.href)) {
          seen.add(link.href);
          vacancies.push({ url: link.href, title: title.textContent.trim() });
        }
      });

      // 3. Универсальный fallback — любые ссылки на вакансии
      if (vacancies.length === 0) {
        document.querySelectorAll('a[href*="/vacancy/"]').forEach((link) => {
          const href = link.href.split('?')[0];
          if (!/\/vacancy\/\d+/.test(href) || seen.has(href)) return;
          const title = link.textContent.trim();
          if (title && title.length > 3 && title.length < 200) {
            seen.add(href);
            vacancies.push({ url: href, title });
          }
        });
      }

      sendResponse(vacancies);
    }

    if (msg.action === 'getVacancyInfo') {
      const descEl = document.querySelector('div[data-qa="vacancy-description"]');
      const applyBtn = document.querySelector('a[data-qa="vacancy-response-link-top"]');

      if (!descEl) {
        sendResponse({ canApply: false, reason: 'Описание не найдено' });
        return;
      }
      if (!applyBtn) {
        sendResponse({ canApply: false, reason: 'Кнопка "Откликнуться" не найдена' });
        return;
      }
      if (applyBtn.getAttribute('aria-disabled') === 'true') {
        sendResponse({ canApply: false, reason: 'Уже откликнулись или отклик недоступен' });
        return;
      }

      const titleEl = document.querySelector('h1[data-qa="vacancy-title"]');
      const companyEl = document.querySelector('a[data-qa="vacancy-company-name"]')
        || document.querySelector('span[data-qa="vacancy-company-name"]');

      sendResponse({
        canApply: true,
        description: descEl.innerText.substring(0, 3000),
        title: titleEl ? titleEl.textContent.trim() : '',
        company: companyEl ? companyEl.textContent.trim() : ''
      });
    }

    if (msg.action === 'clickApply') {
      const btn = document.querySelector('a[data-qa="vacancy-response-link-top"]');
      if (btn) btn.click();
      sendResponse({ ok: true });
    }

    if (msg.action === 'dismissRelocationWarning') {
      const confirmBtn = document.querySelector('[data-qa="relocation-warning-confirm"]');
      if (confirmBtn) {
        confirmBtn.click();
        sendResponse({ dismissed: true });
      } else {
        sendResponse({ dismissed: false });
      }
    }

    // Собрать информацию о форме: вопросы и тип
    if (msg.action === 'getFormInfo') {
      const taskBodies = document.querySelectorAll('[data-qa="task-body"]');
      const questions = [];

      taskBodies.forEach((body) => {
        const qEl = body.querySelector('[data-qa="task-question"]');
        if (!qEl) return;
        const text = qEl.innerText;

        // Проверяем тип: radio, checkbox или текстовый вопрос
        const radios = body.querySelectorAll('input[type="radio"]');
        const checkboxes = body.querySelectorAll('input[type="checkbox"]');

        if (radios.length > 0) {
          const options = [];
          radios.forEach((radio) => {
            const label = radio.closest('label');
            const optText = label
              ? (label.querySelector('[data-qa="cell-text-content"]')?.innerText || '')
              : '';
            options.push({ value: radio.value, text: optText.trim() });
          });
          questions.push({
            type: 'radio',
            text,
            name: radios[0].name,
            options
          });
        } else if (checkboxes.length > 0) {
          const options = [];
          checkboxes.forEach((cb) => {
            const label = cb.closest('label');
            const optText = label
              ? (label.querySelector('[data-qa="cell-text-content"]')?.innerText || '')
              : '';
            options.push({ value: cb.value, text: optText.trim() });
          });
          questions.push({
            type: 'checkbox',
            text,
            name: checkboxes[0].name,
            options
          });
        } else {
          questions.push({ type: 'text', text });
        }
      });

      // Fallback: если task-body не нашли, ищем старым способом
      if (questions.length === 0) {
        const oldQuestions = document.querySelectorAll('[data-qa="task-question"]');
        oldQuestions.forEach((q) => questions.push({ type: 'text', text: q.innerText }));
      }

      const hasPopupLetter = !!document.querySelector(
        'textarea[data-qa="vacancy-response-popup-form-letter-input"]'
      );
      const hasInlineLetter = !!document.querySelector(
        '[data-qa="textarea-wrapper"] textarea[name="text"]'
      );
      const hasLetterToggle = !!document.querySelector(
        '[data-qa="vacancy-response-letter-toggle"]'
      );

      sendResponse({
        questions,
        hasPopupLetter,
        hasInlineLetter,
        hasLetterToggle
      });
    }

    // Заполнить форму готовыми текстами и отправить
    if (msg.action === 'fillAndSubmit') {
      (async () => {
        try {
          const { answers, coverLetter } = msg;
          const questions = document.querySelectorAll('[data-qa="task-question"]');

          if (questions.length > 0) {
            // Форма с вопросами — привязка к task-body по индексу
            const taskBodies = document.querySelectorAll('[data-qa="task-body"]');
            for (let i = 0; i < answers.length; i++) {
              const ans = answers[i];
              const body = taskBodies[i];
              if (!ans || !body) continue;

              if (ans.type === 'radio') {
                const radio = body.querySelector(
                  `input[type="radio"][value="${ans.value}"]`
                );
                if (radio) {
                  const label = radio.closest('label');
                  if (label) label.click(); else radio.click();
                }
              } else if (ans.type === 'checkbox') {
                for (const val of ans.values) {
                  const cb = body.querySelector(
                    `input[type="checkbox"][value="${val}"]`
                  );
                  if (cb) {
                    const label = cb.closest('label');
                    if (label) label.click(); else cb.click();
                    await delay();
                  }
                }
                if (ans.openText) {
                  await sleep(500);
                  const openTa = body.querySelector(`textarea[name="${ans.name}_text"]`);
                  if (openTa) setTextareaValue(openTa, ans.openText);
                }
              } else {
                // Текстовый ответ — ищем textarea внутри этого task-body
                const ta = body.querySelector('textarea[name^="task_"][name$="_text"]');
                if (ta && ans.value) setTextareaValue(ta, ans.value);
              }
              await delay();
            }

            // Открыть форму сопроводительного письма
            const toggle = document.querySelector('[data-qa="vacancy-response-letter-toggle"]');
            if (toggle) {
              toggle.click();
              await sleep(1000);
            }

            // Сопроводительное письмо — пробуем разные селекторы
            const letterTa = document.querySelector(
              'textarea[data-qa="vacancy-response-popup-form-letter-input"]'
            ) || document.querySelector(
              '[data-qa="textarea-wrapper"] textarea[name="text"]'
            ) || document.querySelector(
              'textarea[data-qa="vacancy-response-letter-input"]'
            );
            if (letterTa) {
              setTextareaValue(letterTa, coverLetter);
              await delay();
            }

            // Кнопка отправки — пробуем разные селекторы
            const submitBtn = document.querySelector('[data-qa="vacancy-response-submit-popup"]')
              || document.querySelector('[data-qa="vacancy-response-letter-submit"]')
              || document.querySelector('[data-qa="vacancy-response-submit"]')
              || document.querySelector('button[type="submit"]');
            if (!submitBtn) throw new Error('Кнопка отправки не найдена');
            submitBtn.click();
            await sleep(2000);

            // Проверяем, что форма отправилась (нет ошибок валидации)
            const invalidFields = document.querySelectorAll('[aria-invalid="true"]');
            if (invalidFields.length > 0) {
              sendResponse({ success: false, error: 'Форма не отправлена: есть незаполненные обязательные поля' });
            } else {
              sendResponse({ success: true });
            }

          } else {
            // Форма без вопросов
            const popupTa = document.querySelector(
              'textarea[data-qa="vacancy-response-popup-form-letter-input"]'
            );

            if (popupTa) {
              setTextareaValue(popupTa, coverLetter);
              await delay();

              const submitBtn = document.querySelector('[data-qa="vacancy-response-submit-popup"]');
              if (!submitBtn) throw new Error('Кнопка отправки не найдена');
              submitBtn.click();
              await sleep(2000);
              sendResponse({ success: true });
            } else {
              const textarea = await waitFor('[data-qa="textarea-wrapper"] textarea[name="text"]', 5000);
              setTextareaValue(textarea, coverLetter);
              await delay();

              const submitBtn = document.querySelector('[data-qa="vacancy-response-letter-submit"]');
              if (!submitBtn) throw new Error('Кнопка отправки не найдена');
              submitBtn.click();
              await sleep(2000);
              sendResponse({ success: true });
            }
          }
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
  });
})();
