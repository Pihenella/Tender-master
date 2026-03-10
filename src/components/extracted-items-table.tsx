interface ExtractedItem {
  _id: string;
  name: string;
  quantity: number;
  unit: string;
  nmckPrice: number;
  tzSpecs: string;
  estimatedWeight: number;
  deliveryCost: number;
  deliveryCostEstimated: boolean;
  quarter: string;
}

export function ExtractedItemsTable({ items }: { items: ExtractedItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-50 border-b">
            <th className="text-left p-2">№</th>
            <th className="text-left p-2">Наименование</th>
            <th className="text-right p-2">Кол-во</th>
            <th className="text-left p-2">Ед.</th>
            <th className="text-right p-2">НМЦК/ед.</th>
            <th className="text-left p-2">ТЗ</th>
            <th className="text-right p-2">Вес (кг)</th>
            <th className="text-right p-2">Доставка</th>
            <th className="text-left p-2">Квартал</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={item._id} className="border-b hover:bg-gray-50">
              <td className="p-2">{i + 1}</td>
              <td className="p-2 max-w-[200px] truncate" title={item.name}>
                {item.name}
              </td>
              <td className="p-2 text-right">{item.quantity}</td>
              <td className="p-2">{item.unit}</td>
              <td className="p-2 text-right">
                {item.nmckPrice.toLocaleString("ru-RU")}
              </td>
              <td className="p-2 max-w-[150px] truncate" title={item.tzSpecs}>
                {item.tzSpecs}
              </td>
              <td className="p-2 text-right">{item.estimatedWeight}</td>
              <td className="p-2 text-right">
                {item.deliveryCost.toLocaleString("ru-RU")}
                {item.deliveryCostEstimated && (
                  <span
                    className="text-amber-500 ml-1"
                    title="Примерная оценка ИИ — проверить!"
                  >
                    !
                  </span>
                )}
              </td>
              <td className="p-2">{item.quarter}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
