import {
  deleteReconSnapshot,
  listReconSnapshots,
  readReconSnapshotArtifact,
  readReconSnapshotImage,
  RECON_SNAPSHOT_API_PATH,
  updateReconSnapshotNote,
} from './recon-snapshot-store.mjs'

export async function tryHandleReconRoute({
  request,
  requestUrl,
  response,
  readJsonBody,
  sendJson,
  captureReconSnapshot,
}) {
  const { method } = request
  const { pathname } = requestUrl

  if (method === 'GET' && pathname === RECON_SNAPSHOT_API_PATH) {
    const limit = parsePositiveInteger(requestUrl.searchParams.get('limit'), 24)
    return sendJson(response, 200, {
      status: 'ok',
      snapshots: await listReconSnapshots({ limit }),
    })
  }

  const reconSnapshotImageId = matchReconSnapshotImagePath(pathname)
  if (method === 'GET' && reconSnapshotImageId) {
    return sendReconSnapshotImage({ response, sendJson, id: reconSnapshotImageId })
  }

  const reconSnapshotArtifact = matchReconSnapshotArtifactPath(pathname)
  if (method === 'GET' && reconSnapshotArtifact) {
    return sendReconSnapshotArtifact({
      response,
      sendJson,
      id: reconSnapshotArtifact.id,
      artifact: reconSnapshotArtifact.artifact,
    })
  }

  if (method === 'POST' && pathname === RECON_SNAPSHOT_API_PATH) {
    const body = await readJsonBody(request)
    const result = await captureReconSnapshot(body || {})

    if (!result.ok) {
      return sendJson(response, result.statusCode || 502, {
        status: 'error',
        error: result.error || 'Recon snapshot failed.',
        robotState: result.robotState,
        lidarScan: result.lidarScan,
      })
    }

    return sendJson(response, 201, result.snapshot)
  }

  const reconSnapshotId = matchReconSnapshotPath(pathname)
  if (method === 'PATCH' && reconSnapshotId) {
    const body = await readJsonBody(request)
    try {
      return sendJson(response, 200, await updateReconSnapshotNote(reconSnapshotId, {
        note: body?.note,
        tags: body?.tags,
      }))
    } catch (error) {
      const statusCode = error?.code === 'ENOENT' ? 404 : error?.code === 'EINVAL' ? 400 : 500
      return sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Could not update recon snapshot.',
      })
    }
  }

  if (method === 'DELETE' && reconSnapshotId) {
    try {
      return sendJson(response, 200, await deleteReconSnapshot(reconSnapshotId))
    } catch (error) {
      const statusCode = error?.code === 'ENOENT' ? 404 : error?.code === 'EINVAL' ? 400 : 500
      return sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Could not delete recon snapshot.',
      })
    }
  }

  return false
}

async function sendReconSnapshotImage({ response, sendJson, id }) {
  try {
    const image = await readReconSnapshotImage(id)
    response.writeHead(200, {
      'content-type': image.contentType,
      'cache-control': 'private, max-age=60',
    })
    response.end(image.buffer)
  } catch (error) {
    const statusCode = error?.code === 'ENOENT' ? 404 : error?.code === 'EINVAL' ? 400 : 500
    return sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : 'Recon snapshot image unavailable.',
    })
  }
}

async function sendReconSnapshotArtifact({ response, sendJson, id, artifact }) {
  try {
    const result = await readReconSnapshotArtifact(id, artifact)
    response.writeHead(200, {
      'content-type': result.contentType,
      'cache-control': 'private, max-age=60',
    })
    response.end(result.buffer)
  } catch (error) {
    const statusCode = error?.code === 'ENOENT' ? 404 : error?.code === 'EINVAL' ? 400 : 500
    return sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : 'Recon snapshot artifact unavailable.',
    })
  }
}

function matchReconSnapshotImagePath(pathname) {
  const match = /^\/api\/recon\/snapshots\/([^/]+)\/image$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : ''
}

function matchReconSnapshotArtifactPath(pathname) {
  const match = /^\/api\/recon\/snapshots\/([^/]+)\/lidar\.(json|csv)$/.exec(pathname)
  return match ? {
    id: decodeURIComponent(match[1]),
    artifact: match[2],
  } : null
}

function matchReconSnapshotPath(pathname) {
  const match = /^\/api\/recon\/snapshots\/([^/]+)$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : ''
}

function parsePositiveInteger(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}
