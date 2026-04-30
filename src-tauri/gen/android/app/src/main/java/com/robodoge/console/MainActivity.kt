package com.robodoge.console

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    requestMicrophonePermission()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.webChromeClient = object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) {
        runOnUiThread {
          val audioOnly = request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
          if (audioOnly && hasMicrophonePermission()) {
            request.grant(request.resources)
          } else {
            request.deny()
          }
        }
      }
    }
  }

  private fun requestMicrophonePermission() {
    if (hasMicrophonePermission()) {
      return
    }

    ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1001)
  }

  private fun hasMicrophonePermission(): Boolean {
    return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
  }
}
