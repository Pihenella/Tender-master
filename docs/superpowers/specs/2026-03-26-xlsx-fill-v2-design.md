# XLSX Fill V2 — Двухфазное заполнение Excel форм

## Проблема

Текущий pipeline (V1) для заполнения Excel форм ненадёжен:
- Claude получает плоский текст `Row N: val1 | val2` без информации о структуре
- Claude должен угадать числовые координаты `{row, col}` — часто промахивается
- Пустые строки пропускаются парсером, номера строк сдвигаются
- Нет информации о merged cells — координаты неоднозначны
- Нет проверки результата — ошибки остаются незамеченными
- Основной симптом: данные не записываются в ячейки, хотя инструкция есть

## Решение

Двухфазная модель: Claude решает семантическую задачу "что куда" (в чём он силён), программный код выполняет подстановку по точным адресам ячеек (в чём код надёжен).

## Архитектура

### V1/V2 сосуществование

V1 остаётся без изменений. V2 работает параллельно, выбирается через toggle.

```
V1 (текущий):  parseXlsx → "Row N: ..." → Claude → {row, col, value} → applyXlsxInstructions
V2 (новый):    buildFormMap → карта формы → Claude маппинг → программная подстановка → self-check → applyXlsxV2
```

Переключение через флаг `fillEngine: "v1" | "v2"` на уровне procurement или глобально.
По умолчанию V1, пока V2 не стабилизируется.

### Компоненты

| Компонент | Файл | Описание |
|-----------|------|----------|
| `buildFormMap()` | `src/lib/server/formMap.ts` | Анализ структуры Excel, построение карты regions |
| `FORM_PROMPT_V2` | `src/lib/server/processor.ts` | Промпт для фазы 1 — маппинг полей по карте |
| `resolveMapping()` | `src/lib/server/fillV2.ts` | Программная подстановка данных по маппингу |
| `applyXlsxV2()` | `src/lib/server/fillV2.ts` | Запись значений в Excel по cell addresses |
| `selfCheck()` | `src/lib/server/fillV2.ts` | Программная проверка + 1 retry |
| UI toggle | `src/routes/...` | V1/V2 переключатель |
| UI статус | `src/routes/...` | Отчёт о заполнении (N/M полей) |

---

## Карта формы (buildFormMap)

Программный анализ Excel файла, выдаёт структурированное описание:

```typescript
interface FormMap {
  sheet: string;
  dimensions: string;              // "A1:F25"
  mergedCells: string[];           // ["A1:F1", "A3:B3"]
  regions: Region[];
}

type Region =
  | { type: "header"; range: string; value: string }
  | { type: "field"; label: CellRef; input: CellRef }
  | { type: "table"; headerRow: number; columns: TableColumn[]; dataStartRow: number; existingRows: number }
  | { type: "static"; cell: string; value: string }

interface CellRef {
  cell: string;   // "A5"
  value: string;  // "ИНН" или ""
}

interface TableColumn {
  col: string;    // "A"
  header: string; // "Наименование"
}
```

### Эвристики определения regions

- **field** — ячейка с текстом + соседняя пустая ячейка (или с `____`, `_______`)
- **table** — строка, где 3+ ячеек подряд заполнены текстом (заголовки), за которой идут пустые строки
- **header** — merged cells с текстом или крупный текст без парных полей ввода
- **static** — заполненный текст, который не нужно менять (контекст для Claude)

### Пример выхода

```json
{
  "sheet": "Лист1",
  "dimensions": "A1:F25",
  "mergedCells": ["A1:F1", "A3:B3"],
  "regions": [
    {
      "type": "header",
      "range": "A1:F1",
      "value": "ФОРМА ЗАЯВКИ НА УЧАСТИЕ"
    },
    {
      "type": "field",
      "label": { "cell": "A5", "value": "ИНН" },
      "input": { "cell": "B5", "value": "" }
    },
    {
      "type": "field",
      "label": { "cell": "A6", "value": "Наименование организации" },
      "input": { "cell": "B6", "value": "" }
    },
    {
      "type": "table",
      "headerRow": 10,
      "columns": [
        { "col": "A", "header": "№ п/п" },
        { "col": "B", "header": "Наименование" },
        { "col": "C", "header": "Кол-во" },
        { "col": "D", "header": "Цена за ед." },
        { "col": "E", "header": "Стоимость" }
      ],
      "dataStartRow": 11,
      "existingRows": 0
    }
  ]
}
```

---

## Фаза 1 — Маппинг полей (Claude)

Claude получает карту формы + данные и определяет соответствие:

### Вход
```
{ formMap, profileData, procurementData }
```

### Выход
```json
{
  "mappings": [
    { "cell": "B5", "dataPath": "profile.inn", "confidence": "high" },
    { "cell": "B6", "dataPath": "profile.fullName", "confidence": "high" },
    { "cell": "B7", "dataPath": "profile.legalAddress", "confidence": "medium" }
  ],
  "tables": [
    {
      "dataStartRow": 11,
      "columnMap": {
        "A": "rowNumber",
        "B": "pricing.items[].name",
        "C": "pricing.items[].quantity",
        "D": "pricing.items[].unitPrice",
        "E": "pricing.items[].totalPrice"
      }
    }
  ],
  "unmapped": ["C3"],
  "computed": [
    { "cell": "E20", "expression": "SUM(pricing.items[].totalPrice)", "label": "Итого" }
  ]
}
```

### Уровни confidence
- **high** — однозначное соответствие (ИНН → profile.inn)
- **medium** — вероятное соответствие, но label неоднозначен
- **low** — угадывание, нужна проверка

---

## Фаза 2 — Программная подстановка (resolveMapping)

Без Claude. Код берёт маппинг и подставляет значения:

1. Для каждого mapping с `confidence: "high"` или `"medium"` — достаём значение по `dataPath` из данных
2. Для tables — генерируем строки из `pricing.items[]` по `columnMap`
3. Для `computed` — вычисляем (суммы, подсчёты)
4. Для `unmapped` и `confidence: "low"` — отправляем в Claude с контекстом "эти поля остались, что туда писать?"

Результат: массив `{ cell: string, value: string | number }[]` для записи.

---

## Применение к файлу (applyXlsxV2)

```typescript
async function applyXlsxV2(
  buffer: Buffer,
  cellValues: { cell: string; value: string | number }[],
  tableData?: { startRow: number; rows: Record<string, string | number>[] }
): Promise<Buffer>
```

- Запись по адресам ячеек (`ws.getCell("B5").value = "662302062065"`)
- Для таблиц — запись строк начиная с `startRow`
- Учёт merged cells — запись в master cell
- Сохранение существующих стилей ячеек

---

## Self-check

После применения — программная проверка:

```typescript
interface CheckResult {
  applied: number;     // успешно записано
  failed: number;      // значение не совпало с ожидаемым
  missing: number;     // unmapped поля, похожие на input
  details: {
    cell: string;
    expected: string;
    actual: string;
    reason: "merged_cell" | "write_failed" | "protected" | "unmapped";
  }[];
}
```

### Retry логика
1. Перечитать заполненный файл
2. Для каждого mapping проверить: `ws.getCell(cell).value === expectedValue`
3. Если есть failed:
   - merged cell → попробовать master cell
   - write failed → повторная запись
4. Если есть missing → один вызов Claude: "эти поля остались незаполненными, что туда писать?"
5. Максимум 1 retry

---

## UI

### Переключатель V1/V2
- Toggle в настройках обработки или на странице procurement
- Хранится как `fillEngine: "v1" | "v2"`
- По умолчанию `"v1"`

### Отчёт о заполнении
Рядом с заполненным файлом:
- `✓ 14/14 полей заполнено` (зелёный)
- `⚠ 12/14 полей, 2 не удалось` (жёлтый) — раскрывающийся список проблемных ячеек с причинами

Данные берутся из `CheckResult`, который уже есть после self-check.

---

## Вне scope

- DOCX заполнение — остаётся V1
- Carbone/шаблонный движок — отдельный scope (V3)
- Кнопка "Перезаполнить" с фидбэком — отдельная итерация
- Автоматический выбор V1/V2 — пока ручной toggle
- Поддержка .xls (старый формат) — только .xlsx

---

## Зависимости

- **ExcelJS** — уже в проекте, используется для чтения/записи
- **Claude API** — уже в проекте, один дополнительный вызов на фазу 1
- Новых зависимостей не требуется
