// Мережевий такт. Сервер рахує 30 тіків/с; кожен тік = 2 кроки симуляції по 1/60 с —
// фізика з Lab 1 (крок 1/60) лишається тією самою, змінюється лише частота обміну.
export const TICK_RATE = 30
export const TICK_MS = 1000 / TICK_RATE
export const SUBSTEPS = 2
export const STEP = 1 / (TICK_RATE * SUBSTEPS)
