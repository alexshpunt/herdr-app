// Shared by the picker and its focused unit tests.
export function modelChoices(catalog, query = "", fallback = false) {
  const q = query.trim().toLowerCase();
  const choices = (catalog?.models ?? []).filter(model => typeof model.id === "string" && typeof model.name === "string")
    .filter(model => `${model.name} ${model.id}`.toLowerCase().includes(q));
  const id = query.trim();
  const manual = /^[A-Za-z0-9._:@+-]+\/[A-Za-z0-9._:/@+-]+$/.test(id)
    && !(catalog?.models ?? []).some(model => model.id.toLowerCase() === q)
    ? [{ id, name: `Select this model: ${id}`, manual: true }] : [];
  return [...(fallback && (!q || "no fallback".includes(q)) ? [{ id: null, name: "No fallback" }] : []), ...choices, ...manual];
}

export function currentModelLabel(catalog, id, fallback = false) {
  if (!id) return fallback ? "No fallback" : "Choose a model";
  return catalog?.models?.find(model => model.id === id)?.name ?? id;
}
