package com.mabisuuu.fcdownloader.aria2

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * FcAria2Package — registers FcAria2Module with the React Native bridge.
 *
 * Register this package in MainApplication.kt:
 *
 *   override fun getPackages(): List<ReactPackage> = PackageList(this).packages.apply {
 *       add(FcAria2Package())
 *   }
 *
 * This is the ONLY change required in the Android host app to activate the
 * aria2c transport layer. The JS bridge (aria2Transport.ts) will automatically
 * detect the module and use it when USE_ARIA2_ANDROID is true.
 */
class FcAria2Package : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(FcAria2Module(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
