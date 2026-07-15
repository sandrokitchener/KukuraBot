import { buildIsaacSimPreview } from './isaacsim-command-compiler.mjs'
import {
  dispatchIsaacSimCommand,
  getIsaacRuntimeFeedback,
  getIsaacSidecarHealth,
} from './isaacsim-sidecar-client.mjs'
import { loadPublicConfig, processModelResult, processUserInput } from './app-service.mjs'
import { setActiveModelProfile } from './model-profile-config.mjs'
import { buildRobotManualControlPreview, buildRobotRuntimePreview } from './robot-command-compiler.mjs'
import {
  dispatchRobotCommand,
  dispatchRobotEmergencyStop,
  dispatchRobotEmergencyStopClear,
  getRobotRuntimeFeedback,
  getRobotSidecarHealth,
} from './robot-sidecar-client.mjs'
import {
  loadRobotRuntimeConfig,
  setActiveRobotPerformanceProfile,
  setActiveRobotTarget,
} from './robot-runtime-config.mjs'
import {
  resolveActiveSpeechProfile,
  saveSpeechRuntimeConfig,
} from './speech-profile-config.mjs'
import {
  getSpeechSidecarHealth,
  transcribeSpeechInput,
} from './speech-sidecar-client.mjs'
import {
  acquireRobotLease,
  getRobotLease,
  releaseRobotLease,
  renewRobotLease,
} from './robot-lease.mjs'

export async function tryHandleRuntimeRoute({
  request,
  requestUrl,
  response,
  readJsonBody,
  sendJson,
  buildCurrentRobotStateSnapshot,
  recordNavigationDispatch = () => {},
  resetNavigationDispatch = () => {},
  loadPublicConfigImpl = loadPublicConfig,
  loadRobotRuntimeConfigImpl = loadRobotRuntimeConfig,
  setActiveRobotPerformanceProfileImpl = setActiveRobotPerformanceProfile,
}) {
  const { method } = request
  const { pathname } = requestUrl

  if (method === 'GET' && pathname === '/api/config') {
    return sendJson(response, 200, await loadPublicConfigImpl())
  }

  if (method === 'POST' && pathname === '/api/chat') {
    const body = await readJsonBody(request)
    const result = await processUserInput(body?.input)
    recordWaypointDispatchFromResult(result, recordNavigationDispatch)
    return sendJson(response, 200, result)
  }

  if (method === 'POST' && pathname === '/api/chat/result') {
    const body = await readJsonBody(request)
    const result = await processModelResult({
      input: body?.input,
      rawResponse: body?.rawResponse,
    })
    recordWaypointDispatchFromResult(result, recordNavigationDispatch)
    return sendJson(response, 200, result)
  }

  if (method === 'POST' && pathname === '/api/settings/profile') {
    const body = await readJsonBody(request)
    const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''

    if (!profileId) {
      return sendJson(response, 400, { error: 'Select a profile first.' })
    }

    try {
      await setActiveModelProfile(profileId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update profile.'
      const statusCode = /locked/i.test(message) ? 409 : 400
      return sendJson(response, statusCode, { error: message })
    }

    return sendJson(response, 200, await loadPublicConfig())
  }

  if (method === 'POST' && pathname === '/api/settings/speech-profile') {
    const body = await readJsonBody(request)
    const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''

    if (!profileId) {
      return sendJson(response, 400, { error: 'Select a speech profile first.' })
    }

    try {
      const speechConfig = await resolveActiveSpeechProfile()
      const profileExists = speechConfig.availableProfiles.some((profile) => profile.id === profileId)

      if (!profileExists) {
        return sendJson(response, 400, { error: `Unknown speech profile "${profileId}".` })
      }

      if (speechConfig.selectionLocked) {
        return sendJson(response, 409, { error: 'Speech profile locked by APP_SPEECH_PROFILE.' })
      }

      await saveSpeechRuntimeConfig({ activeProfile: profileId })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update speech profile.'
      const statusCode = /locked/i.test(message) ? 409 : 400
      return sendJson(response, statusCode, { error: message })
    }

    return sendJson(response, 200, await loadPublicConfig())
  }

  if (method === 'POST' && pathname === '/api/settings/robot-target') {
    const body = await readJsonBody(request)
    const targetId = typeof body?.targetId === 'string' ? body.targetId.trim() : ''

    if (!targetId) {
      return sendJson(response, 400, { error: 'Select a robot target first.' })
    }

    try {
      const runtimeConfig = await loadRobotRuntimeConfig()

      if (runtimeConfig.selectionLocked) {
        return sendJson(response, 409, { error: 'Robot target locked by ROBOT_RUNTIME_TARGET.' })
      }

      await setActiveRobotTarget(targetId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update robot target.'
      return sendJson(response, 400, { error: message })
    }

    return sendJson(response, 200, await loadPublicConfig())
  }

  if (method === 'POST' && pathname === '/api/settings/performance-profile') {
    const body = await readJsonBody(request)
    const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''
    if (!profileId) {
      return sendJson(response, 400, { error: 'Select a performance profile first.' })
    }

    try {
      const runtimeConfig = await loadRobotRuntimeConfigImpl()
      if (runtimeConfig.performanceSelectionLocked) {
        return sendJson(response, 409, { error: 'Performance profile locked by ROBOT_PERFORMANCE_PROFILE.' })
      }
      await setActiveRobotPerformanceProfileImpl(profileId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update performance profile.'
      return sendJson(response, 400, { error: message })
    }

    return sendJson(response, 200, await loadPublicConfigImpl())
  }

  if (method === 'GET' && pathname === '/api/isaac/health') {
    return sendJson(response, 200, await getIsaacSidecarHealth())
  }

  if (method === 'GET' && pathname === '/api/isaac/feedback') {
    return sendJson(response, 200, await getIsaacRuntimeFeedback())
  }

  if (method === 'GET' && pathname === '/api/robot/health') {
    const options = requestUrl.searchParams.get('lite') === '1' ? { path: '/healthz-lite' } : {}
    return sendJson(response, 200, await getRobotSidecarHealth(options))
  }

  if (method === 'GET' && pathname === '/api/robot/feedback') {
    return sendJson(response, 200, await getRobotRuntimeFeedback())
  }

  if (method === 'GET' && pathname === '/api/robot/state') {
    return sendJson(response, 200, await buildCurrentRobotStateSnapshot())
  }

  if (pathname === '/api/robot/lease') {
    const robotId = requestUrl.searchParams.get('robotId') || 'default'
    if (method === 'GET') return sendJson(response, 200, { lease: getRobotLease(robotId) })
    const body = await readJsonBody(request)
    const input = { robotId, holder: body?.holder, fencingToken: body?.fencingToken }
    const result = method === 'POST'
      ? acquireRobotLease({ ...input, takeover: body?.takeover === true })
      : method === 'PATCH'
        ? renewRobotLease(input)
        : method === 'DELETE'
          ? releaseRobotLease(input)
          : null
    if (!result) return sendJson(response, 405, { error: 'Method not allowed.' })
    return sendJson(response, result.ok ? 200 : result.status === 'conflict' ? 409 : 409, result)
  }

  if (method === 'GET' && pathname === '/api/speech/health') {
    return sendJson(response, 200, await getSpeechSidecarHealth())
  }

  if (method === 'POST' && pathname === '/api/speech/transcribe') {
    const body = await readJsonBody(request)
    const speechConfig = await resolveActiveSpeechProfile()
    const activeSpeechProfile = speechConfig.activeProfile

    if (activeSpeechProfile.provider !== 'parakeet-sidecar') {
      return sendJson(response, 400, {
        error: `Active speech profile "${activeSpeechProfile.label}" does not use server transcription.`,
      })
    }

    const result = await transcribeSpeechInput({
      audioBase64: typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '',
      mimeType: typeof body?.mimeType === 'string' ? body.mimeType.trim() : 'audio/wav',
      sampleRate: Number.isFinite(body?.sampleRate) ? body.sampleRate : 16000,
      timestamps: activeSpeechProfile.timestamps ?? true,
      modelId: activeSpeechProfile.sidecarModelId || activeSpeechProfile.modelId,
      language: activeSpeechProfile.language,
      task: activeSpeechProfile.task,
      device: activeSpeechProfile.device,
    })

    const statusCode = result.status === 'ok' ? 200 : result.status === 'invalid-audio' ? 400 : 502
    return sendJson(response, statusCode, result)
  }

  if (method === 'POST' && pathname === '/api/isaac/dispatch') {
    const body = await readJsonBody(request)
    const preview =
      body?.preview && typeof body.preview === 'object'
        ? body.preview
        : await buildIsaacSimPreview({
          input: body?.input,
          rawResponse: body?.rawResponse,
          parsed: body?.parsed,
        })
    const dispatch = await dispatchIsaacSimCommand(preview)
    const statusCode = dispatch.status === 'error' ? 502 : 200
    return sendJson(response, statusCode, { preview, dispatch })
  }

  if (method === 'POST' && pathname === '/api/robot/dispatch') {
    const body = await readJsonBody(request)
    const preview =
      body?.preview && typeof body.preview === 'object'
        ? body.preview
        : await buildRobotRuntimePreview({
          input: body?.input,
          rawResponse: body?.rawResponse,
          parsed: body?.parsed,
        })
    const dispatch = await dispatchRobotCommand(preview)
    if (['sent', 'accepted'].includes(dispatch.status)) {
      const wp = preview?.canonicalPlan?.params?.waypoint
      if (wp) {
        const commandId = dispatch.commandId || dispatch.body?.result?.commandId || dispatch.body?.commandId || null
        recordNavigationDispatch({
          waypointName: wp,
          arrivalTolerance: preview?.canonicalPlan?.params?.arrivalToleranceMeters,
          ...(commandId ? { commandId } : {}),
        })
      }
    }
    const statusCode = dispatch.status === 'error' ? 502 : 200
    return sendJson(response, statusCode, { preview, dispatch })
  }

  if (method === 'POST' && pathname === '/api/robot/manual-control') {
    const body = await readJsonBody(request)
    const preview = await buildRobotManualControlPreview(body || {})
    const dispatch = await dispatchRobotCommand(preview)
    const statusCode = dispatch.status === 'error' ? 502 : 200
    return sendJson(response, statusCode, { preview, dispatch })
  }

  if (method === 'POST' && pathname === '/api/robot/stop') {
    const body = await readJsonBody(request)
    const action = body?.action === 'clear' ? 'clear' : 'stop'
    resetNavigationDispatch()
    const dispatch = action === 'clear'
      ? await dispatchRobotEmergencyStopClear()
      : await dispatchRobotEmergencyStop()
    const statusCode = dispatch.status === 'error' ? 502 : 200
    return sendJson(response, statusCode, { action, dispatch })
  }

  return false
}

export function recordWaypointDispatchFromResult(result, recordNavigationDispatch) {
  if (!['sent', 'accepted'].includes(result?.robotDispatch?.status)) {
    return
  }

  const wp = result?.robotRuntime?.canonicalPlan?.params?.waypoint
  if (!wp) {
    return
  }

  const commandId = result?.robotDispatch?.commandId || result?.robotDispatch?.body?.result?.commandId || result?.robotDispatch?.body?.commandId || null
  recordNavigationDispatch({
    waypointName: wp,
    arrivalTolerance: result?.robotRuntime?.canonicalPlan?.params?.arrivalToleranceMeters,
    ...(commandId ? { commandId } : {}),
  })
}
