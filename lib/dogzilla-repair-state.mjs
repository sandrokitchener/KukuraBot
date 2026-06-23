const state = {
  repairing: false,
  lastRepairAt: null,
  lastRepairResult: null,
}

export function setDogzillaRepairing(value, meta = null) {
  state.repairing = value === true
  if (state.repairing) {
    state.lastRepairAt = new Date().toISOString()
  }
  if (meta) {
    state.lastRepairResult = meta
  }
}

export function isDogzillaRepairing() {
  return state.repairing === true
}

export function getDogzillaRepairState() {
  return {
    repairing: state.repairing === true,
    lastRepairAt: state.lastRepairAt,
    lastRepairResult: state.lastRepairResult,
  }
}
