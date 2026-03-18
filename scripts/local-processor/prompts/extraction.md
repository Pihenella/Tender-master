You are analyzing Russian procurement (закупка) documentation that has been loaded into a NotebookLM notebook.

## Your task

Use the NotebookLM MCP tools to query the uploaded procurement documents and extract structured data.

## Steps

1. First, use `list_notebooks` to find the notebook for this procurement (match by title)
2. Use `generate_chat` with the notebook_id to make the following queries:

### Query 1: Basic metadata
Ask: "Какой номер закупки, название закупки, НМЦК (начальная максимальная цена контракта), срок поставки? Дай точные значения."

### Query 2: Delivery addresses
Ask: "Какие адреса доставки (грузополучатели) указаны? Дай полный список с названиями и адресами."

### Query 3: Items list
Ask: "Перечисли ВСЕ позиции из ТЗ/спецификации. Для каждой: наименование, количество, единица измерения, цена за единицу (НМЦК), технические характеристики. Дай полный список."

### Query 4: PP1875 restrictions
Ask: "Есть ли ограничения по ПП 1875 (запрет/ограничение/преимущество) для позиций закупки? Для каких именно?"

### Query 5: Delivery allocations
Ask: "Как распределены позиции по адресам доставки? Какие количества на какой адрес?"

### Query 6: Forms for participants
Ask: "Какие формы должен заполнить участник закупки? Ищи в разделах 'Образцы форм', 'Формы для заполнения участниками'. НЕ включай ТЗ, проекты контрактов, инструкции. Для каждой формы укажи: название, в каком файле находится."

## Output format

Return ONLY valid JSON (no markdown fences, no comments):

{
  "procurementNumber": "string",
  "procurementName": "string",
  "nmck": number,
  "deliveryDeadline": "string",
  "deliveryAddresses": [{"name": "string", "address": "string"}],
  "items": [
    {
      "name": "string",
      "quantity": number,
      "unit": "string",
      "nmckPrice": number,
      "tzSpecs": "string - key specs concisely",
      "pp1875": "string or empty",
      "quarter": "string",
      "estimatedWeight": number,
      "estimatedDimensions": "string ДxШxВ см",
      "deliveryAllocations": [{"address": "string", "quantity": number}]
    }
  ],
  "forms": [
    {
      "name": "string",
      "sourceFile": "string",
      "locationType": "paragraph_range | whole_file | sheet",
      "startBlock": number,
      "endBlock": number,
      "sheetName": "string"
    }
  ],
  "calcRows": [
    {
      "itemName": "string - exact name from docs",
      "pp1875": "string or empty",
      "quantity": number,
      "nmckPrice": number,
      "tzSpecs": "string - formatted specs"
    }
  ]
}

IMPORTANT:
- All prices in rubles, no formatting
- estimatedWeight: estimate based on typical weight of the product by its name
- Forms: ONLY forms a participant must fill, NOT ТЗ/contracts/instructions
- calcRows mirrors items but with cleaned-up tzSpecs formatting
