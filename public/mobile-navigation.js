export const MOBILE_VIEWS = Object.freeze(['controls', 'chat', 'vision'])
export const MOBILE_DEFAULT_VIEW = 'chat'

const MOBILE_SWIPE_INTENT_PX = 14
const MOBILE_SWIPE_MIN_PX = 34
const MOBILE_SWIPE_MAX_MS = 1200
const MOBILE_SWIPE_HORIZONTAL_RATIO = 1.05
const MOBILE_SWIPE_VERTICAL_CANCEL_RATIO = 1.2

export function isAndroidAppShell({ navigatorRef = globalThis.navigator, windowRef = globalThis.window } = {}) {
  const userAgent = navigatorRef?.userAgent || ''
  return /Android/i.test(userAgent) && (/\bwv\b/i.test(userAgent) || !!windowRef?.__TAURI_INTERNALS__)
}

function bindManualTouchStick(element, stick, manualControl) {
  if (!element) {
    return
  }

  element.addEventListener('pointerdown', (event) => manualControl.handleTouchPointerDown(event, stick))
  element.addEventListener('pointermove', manualControl.handleTouchPointerMove)
  element.addEventListener('pointerup', manualControl.handleTouchPointerUp)
  element.addEventListener('pointercancel', manualControl.handleTouchPointerCancel)
  element.addEventListener('lostpointercapture', manualControl.handleTouchPointerCancel)
}

function isSwipeBlockedTarget(target) {
  // The command field is the primary Android surface, so a horizontal
  // gesture may legitimately begin there. Keep only controls where a swipe
  // would interfere with editing, tapping, or an open drawer.
  return !!target?.closest?.('input, select, button, a, [contenteditable="true"], .manual-touch-stick, .settings-drawer, .connection-drawer, .recon-gallery-drawer')
}

function findTouchById(touchList, id) {
  for (let index = 0; index < (touchList?.length || 0); index += 1) {
    const touch = touchList[index]
    if (touch.identifier === id) {
      return touch
    }
  }

  return null
}

export function createMobileNavigationController({
  documentRef,
  navigatorRef,
  windowRef,
  manualControl,
  manualTouchLeftStick,
  manualTouchRightStick,
  appHeader,
  robotStatePanel,
}) {
  let mobileView = MOBILE_DEFAULT_VIEW
  let mobileTouch = null

  function setMobileView(view) {
    mobileView = MOBILE_VIEWS.includes(view) ? view : MOBILE_DEFAULT_VIEW
    documentRef.documentElement.dataset.mobileView = mobileView
  }

  function handleMobileTouchStart(event) {
    if (
      !documentRef.documentElement.classList.contains('android-app') ||
      isSwipeBlockedTarget(event.target) ||
      event.touches?.length > 1
    ) {
      mobileTouch = null
      return
    }

    const touch = event.changedTouches?.[0] || event.touches?.[0]
    mobileTouch = touch
      ? {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        at: Date.now(),
        horizontal: false,
        canceled: false,
      }
      : null
  }

  function handleMobileTouchMove(event) {
    if (!mobileTouch || mobileTouch.canceled) {
      return
    }

    const touch = findTouchById(event.changedTouches, mobileTouch.id) ||
      findTouchById(event.touches, mobileTouch.id)
    if (!touch) {
      return
    }

    const deltaX = touch.clientX - mobileTouch.x
    const deltaY = touch.clientY - mobileTouch.y
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)

    if (!mobileTouch.horizontal) {
      if (absY >= MOBILE_SWIPE_INTENT_PX && absY > absX * MOBILE_SWIPE_VERTICAL_CANCEL_RATIO) {
        mobileTouch.canceled = true
        return
      }

      mobileTouch.horizontal = absX >= MOBILE_SWIPE_INTENT_PX && absX > absY * MOBILE_SWIPE_HORIZONTAL_RATIO
    }

    if (mobileTouch.horizontal) {
      event.preventDefault()
    }
  }

  function handleMobileTouchEnd(event) {
    if (!mobileTouch) {
      return
    }

    const touch = findTouchById(event.changedTouches, mobileTouch.id)
    const start = mobileTouch
    mobileTouch = null

    if (!touch || start.canceled) {
      return
    }

    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    const elapsedMs = Date.now() - start.at

    if (
      elapsedMs > MOBILE_SWIPE_MAX_MS ||
      Math.abs(deltaX) < MOBILE_SWIPE_MIN_PX ||
      Math.abs(deltaX) < Math.abs(deltaY) * MOBILE_SWIPE_HORIZONTAL_RATIO
    ) {
      return
    }

    const currentIndex = MOBILE_VIEWS.indexOf(mobileView)
    const nextIndex = deltaX < 0
      ? Math.min(MOBILE_VIEWS.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1)
    setMobileView(MOBILE_VIEWS[nextIndex])
  }

  function handleMobileTouchCancel() {
    mobileTouch = null
  }

  function init() {
    if (!isAndroidAppShell({ navigatorRef, windowRef })) {
      return false
    }

    documentRef.documentElement.classList.add('android-app')
    if (appHeader && robotStatePanel) appHeader.append(robotStatePanel)
    manualControl.enableTouch()
    bindManualTouchStick(manualTouchLeftStick, 'left', manualControl)
    bindManualTouchStick(manualTouchRightStick, 'right', manualControl)
    setMobileView(MOBILE_DEFAULT_VIEW)
    documentRef.addEventListener('touchstart', handleMobileTouchStart, { passive: true })
    documentRef.addEventListener('touchmove', handleMobileTouchMove, { passive: false })
    documentRef.addEventListener('touchend', handleMobileTouchEnd, { passive: true })
    documentRef.addEventListener('touchcancel', handleMobileTouchCancel, { passive: true })
    return true
  }

  return {
    init,
    setMobileView,
    getMobileView: () => mobileView,
  }
}
