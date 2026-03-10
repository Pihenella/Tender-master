const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  uploaded: { label: "Загружено", color: "bg-gray-100 text-gray-700" },
  analyzing: { label: "Анализ...", color: "bg-blue-100 text-blue-700" },
  analyzed: { label: "Проанализировано", color: "bg-green-100 text-green-700" },
  reviewed: { label: "Проверено", color: "bg-green-200 text-green-800" },
  template_downloaded: {
    label: "Шаблон скачан",
    color: "bg-yellow-100 text-yellow-700",
  },
  calculation_uploaded: {
    label: "Калькуляция загружена",
    color: "bg-orange-100 text-orange-700",
  },
  generating: { label: "Генерация...", color: "bg-blue-100 text-blue-700" },
  completed: { label: "Готово", color: "bg-emerald-100 text-emerald-700" },
  error: { label: "Ошибка", color: "bg-red-100 text-red-700" },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || {
    label: status,
    color: "bg-gray-100",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color}`}
    >
      {config.label}
    </span>
  );
}
