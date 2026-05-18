export function isCollectiveParticipantForm(formName: string) {
  const normalized = formName
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.includes("коллективн");
}
