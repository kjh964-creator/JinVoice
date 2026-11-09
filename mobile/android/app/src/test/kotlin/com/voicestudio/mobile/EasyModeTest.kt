package com.voicestudio.mobile

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.os.Looper
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import com.voicestudio.mobile.data.*
import com.voicestudio.mobile.features.StudioViewModel
import com.voicestudio.mobile.features.easy.EasyFeatures
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

private val vault=object:CredentialVault {
    override fun read(host:String):Secret?=null
    override fun write(host:String,secret:Secret?) = Unit
}

/** Feature switches and the easy home card list: plain rules, no UI. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk=[34])
class EasyFeaturesStoreTest {
    @Test fun easyModeIsTheDefaultWithOnlyTheFourBasicCards() {
        val prefs=Preferences()
        assertTrue(EasyFeatures.easyMode(prefs))
        assertTrue(EasyFeatures.enabled(prefs).isEmpty())
        assertEquals(listOf("create","book","voices","history"),EasyFeatures.homeCards(prefs).map {it.id})
        assertEquals(listOf(EasyFeatures.CREATE,EasyFeatures.BOOK,EasyFeatures.VOICES,EasyFeatures.HISTORY),EasyFeatures.homeCards(prefs).map {it.route})
        assertTrue(EasyFeatures.homeCards(prefs).none {it.extra})
    }
    @Test fun switchedOnFeaturesFollowTheBasicsInListOrderAndUnknownIdsAreIgnored() {
        var prefs=Preferences()
        prefs=EasyFeatures.set(prefs,"tools",true)
        prefs=EasyFeatures.set(prefs,"dub",true)
        prefs=EasyFeatures.set(prefs,"no-such-screen",true)
        assertEquals(setOf("tools","dub"),prefs.enabledFeatures)
        val cards=EasyFeatures.homeCards(prefs)
        assertEquals(listOf("create","book","voices","history","dub","tools"),cards.map {it.id})
        assertEquals(listOf(false,false,false,false,true,true),cards.map {it.extra})
        prefs=EasyFeatures.set(prefs,"dub",false)
        assertEquals(listOf("tools"),EasyFeatures.enabled(prefs).map {it.id})
        // A stale id saved by a newer build never turns into a card.
        assertEquals(listOf("tools"),EasyFeatures.enabled(prefs.copy(enabledFeatures=prefs.enabledFeatures+"gone")).map {it.id})
    }
    @Test fun everyOriginalScreenIsListedOnceWithItsOwnStrings() {
        val ids=EasyFeatures.all.map {it.id}
        assertEquals(ids.distinct(),ids)
        for(route in listOf("speak","voices","design","gallery","stories","audiobook","dub","batch","dictate","transcriptions","workflows","projects","tools","handoff","calls","local-api"))
            assertTrue(route,EasyFeatures.all.any {it.route==route})
        val l=com.voicestudio.mobile.l10n.L10n.load(ApplicationProvider.getApplicationContext(),"ko")
        for(feature in EasyFeatures.all) for(key in listOf(feature.title,feature.detail)) {
            val text=l.t(key)
            assertNotEquals(key,text)
            assertTrue("$key is not Korean: $text",text.any {it in '\uAC00'..'\uD7A3'})
        }
    }
    @Test fun switchedOffFeaturesAndTheirSubScreensAreNotReachable() {
        val off=Preferences()
        for(route in listOf(EasyFeatures.HOME,EasyFeatures.CREATE,EasyFeatures.BOOK,EasyFeatures.HELP,EasyFeatures.FEATURES,"settings","models","connect"))
            assertTrue(route,EasyFeatures.allowed(route,off))
        for(route in listOf("home","dub","project/{id}","host-dubs","dictate","transcriptions","speak","voice/{id}","gallery","tools","audiobook"))
            assertFalse(route,EasyFeatures.allowed(route,off))
        val dub=EasyFeatures.set(off,"dub",true)
        for(route in listOf("dub","project/{id}","host-dubs","projects")) assertTrue(route,EasyFeatures.allowed(route,dub))
        assertFalse(EasyFeatures.allowed("dictate",dub))
        assertEquals(EasyFeatures.CREATE,EasyFeatures.entry("speak",off))
        assertEquals(EasyFeatures.HOME,EasyFeatures.entry("dictate",off))
        assertEquals("dictate",EasyFeatures.entry("dictate",EasyFeatures.set(off,"dictate",true)))
    }
    @Test fun longTextIsSplitIntoChaptersLikeTheDesktopEasyAudiobook() {
        val part={n:Int -> "Part $n"}
        // Existing headings are kept, with an opening chapter for text before the first one.
        assertEquals("# Opening\nHello\n# One\nText",com.voicestudio.mobile.features.easy.easyBookScript("Hello\n# One\nText",part,"Opening"))
        // "Chapter N" lines (and the Korean chapter forms) become headings.
        val marked=com.voicestudio.mobile.features.easy.easyBookScript("Chapter 1\nA\n\nChapter 2\nB\n\uC81C3\uC7A5\nC",part,"Opening")
        assertEquals(listOf("Chapter 1","Chapter 2","\uC81C3\uC7A5"),com.voicestudio.mobile.local.ProductionPlan.parse(marked).chapters)
        // Plain prose is cut at paragraph breaks into parts of about the given size.
        val prose=(1..6).joinToString("\n\n") {"Paragraph $it "+"x".repeat(40)}
        val parts=com.voicestudio.mobile.local.ProductionPlan.parse(com.voicestudio.mobile.features.easy.easyBookScript(prose,part,"Opening",partChars=110)).chapters
        assertEquals(listOf("Part 1","Part 2","Part 3"),parts)
        assertEquals("",com.voicestudio.mobile.features.easy.easyBookScript("  \n ",part,"Opening"))
    }
    @Test fun switchesPersistAndOlderSavedSettingsOpenInEasyMode()=runBlocking {
        val app=ApplicationProvider.getApplicationContext<Context>()
        val key=stringPreferencesKey("preferences")
        // Settings saved by 0.5.10, before easy mode existed.
        val disk=MutableStateFlow<androidx.datastore.preferences.core.Preferences>(mutablePreferencesOf(key to """{"consent":true,"mode":"light","locale":"ko"}"""))
        val data=object:DataStore<androidx.datastore.preferences.core.Preferences> {
            override val data:Flow<androidx.datastore.preferences.core.Preferences> = disk
            override suspend fun updateData(transform:suspend (androidx.datastore.preferences.core.Preferences)->androidx.datastore.preferences.core.Preferences)=transform(disk.value).also {disk.value=it}
        }
        val store=SessionStore(app,vault,data)
        val old=store.preferences.first()
        assertEquals("ko",old.locale);assertTrue(EasyFeatures.easyMode(old));assertTrue(old.enabledFeatures.isEmpty())
        store.update {EasyFeatures.set(EasyFeatures.set(it,"dub",true),"tools",true)}
        store.update {EasyFeatures.showAll(it,true)}
        val reopened=SessionStore(app,vault,data).preferences.first()
        assertEquals(setOf("dub","tools"),reopened.enabledFeatures)
        assertTrue(reopened.showAllFeatures)
        assertEquals("light",reopened.mode)
        store.update {EasyFeatures.showAll(it,false)}
        assertTrue(EasyFeatures.easyMode(SessionStore(app,vault,data).preferences.first()))
    }
}

/** The easy home in the real app shell, plus screenshots for a narrow tall phone (Galaxy Z Flip5, 1080x2640). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk=[34],qualifiers="w411dp-h1005dp-420dpi")
class EasyModeUiTest {
    @get:Rule val compose=createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private lateinit var vm:StudioViewModel
    private lateinit var store:SessionStore
    private fun start(prefs:Preferences) = runBlocking {
        val app=ApplicationProvider.getApplicationContext<Application>()
        androidx.work.testing.WorkManagerTestInitHelper.initializeTestWorkManager(app)
        store=SessionStore(app,vault)
        store.update {prefs}
        vm=StudioViewModel(app,store)
        compose.setContent {StudioApp(vm,reportClient=null)}
        withTimeout(15000) {while(vm.state.value.loading||vm.phone.state.value.loading||vm.preferences.value!=store.preferences.first()) {shadowOf(Looper.getMainLooper()).idle();delay(10)}}
        compose.waitForIdle()
    }
    /** Preference writes run on the view model scope; let them land before checking the screen. */
    private fun settle(done: (Preferences)->Boolean) = runBlocking {
        withTimeout(5000) {while(!done(vm.preferences.value)||vm.preferences.value!=store.preferences.first()) {shadowOf(Looper.getMainLooper()).idle();delay(10)}}
        compose.waitForIdle()
    }
    @After fun stop() {if(::vm.isInitialized) vm.viewModelScope.cancel()}

    @Test fun easyHomeIsTheDefaultAndSwitchedOnFeaturesBecomeCards() {
        start(Preferences(consent=false))
        for(card in listOf("create","book","voices","history")) compose.onNodeWithTag("easy.card.$card").assertExists()
        compose.onNodeWithTag("easy.card.dub").assertDoesNotExist()
        compose.onAllNodesWithText("Dictate").assertCountEquals(0)
        compose.onNodeWithTag("easy.help").assertExists()
        compose.onNodeWithTag("easy.more").performScrollTo().performClick()
        compose.onNodeWithText("Turn features on and off").assertExists()
        compose.onNodeWithTag("easy.feature.dub").performScrollTo().performClick()
        settle {"dub" in it.enabledFeatures}
        assertEquals(setOf("dub"),vm.preferences.value.enabledFeatures)
        compose.onNodeWithTag("easy.home").performClick()
        compose.onNodeWithText("More features").performScrollTo().assertExists()
        compose.onNodeWithTag("easy.card.dub").performScrollTo().performClick()
        compose.onNodeWithText("Choose video or audio").assertExists()
        compose.onNodeWithTag("easy.home").performClick()
        compose.onNodeWithTag("easy.card.create").assertExists()
        // Switching the feature off removes its card.
        runBlocking {store.update {EasyFeatures.set(it,"dub",false)}};settle {it.enabledFeatures.isEmpty()}
        compose.onNodeWithTag("easy.card.dub").assertDoesNotExist()
    }

    @Test fun showAllFeaturesRestoresTheFullStudioAndEasyScreenComesBack() {
        start(Preferences(consent=false))
        compose.onNodeWithTag("easy.settings").performClick()
        compose.onNodeWithContentDescription("Show all features (advanced)").performClick()
        settle {it.showAllFeatures}
        assertTrue(vm.preferences.value.showAllFeatures)
        for(label in listOf("Speak","Voices","Dub","Dictate","Settings")) compose.onAllNodesWithText(label).filter(hasClickAction()).onFirst().assertExists()
        compose.onNodeWithTag("top.easy").performClick()
        settle {!it.showAllFeatures}
        assertFalse(vm.preferences.value.showAllFeatures)
        compose.onNodeWithTag("easy.card.create").assertExists()
    }

    private fun shot(name:String) {
        compose.waitForIdle()
        val dir=File(System.getProperty("user.dir"),"build/outputs/easy-screens").apply {mkdirs()}
        // Draw the activity window directly; captureToImage waits for a real frame Robolectric never sends.
        compose.runOnUiThread {
            val view=compose.activity.window.decorView
            val bitmap=Bitmap.createBitmap(view.width,view.height,Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            File(dir,"$name.png").outputStream().use {bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
        }
    }
    private fun tour(mode:String) {
        start(Preferences(consent=false,locale="ko",mode=mode,enabledFeatures=setOf("dub","dictate","tools")))
        shot("$mode-1-home")
        compose.onRoot().performTouchInput {swipeUp()};shot("$mode-1b-home-more")
        compose.onNodeWithTag("easy.home").assertDoesNotExist()
        compose.onNodeWithTag("easy.card.create").performScrollTo().performClick();shot("$mode-2-create")
        compose.onRoot().performTouchInput {swipeUp(durationMillis=200)};compose.onRoot().performTouchInput {swipeUp(durationMillis=200)};shot("$mode-2b-create-bottom")
        compose.onNodeWithTag("easy.home").performClick()
        compose.onNodeWithTag("easy.card.voices").performScrollTo().performClick();shot("$mode-3-voices")
        compose.onNodeWithText(com.voicestudio.mobile.l10n.L10n.load(ApplicationProvider.getApplicationContext(),"ko").t("easy.register_voice")).performClick();shot("$mode-3b-register")
        compose.onNodeWithTag("easy.home").performClick()
        compose.onNodeWithTag("easy.card.history").performScrollTo().performClick();shot("$mode-4-history")
        compose.onNodeWithTag("easy.home").performClick()
        compose.onNodeWithTag("easy.card.book").performScrollTo().performClick();shot("$mode-5-book")
        compose.onRoot().performTouchInput {swipeUp(durationMillis=200)};shot("$mode-5b-book-more")
        compose.onNodeWithTag("easy.home").performClick()
        compose.onNodeWithTag("easy.help").performClick();shot("$mode-6-help")
        compose.onNodeWithTag("easy.home").performClick()
        compose.onNodeWithTag("easy.more").performScrollTo().performClick();shot("$mode-7-features")
        compose.onNodeWithTag("easy.home").performClick()
        compose.onNodeWithTag("easy.settings").performClick();shot("$mode-8-settings")
    }
    @Test fun screenshotsDark() = tour("dark")
    @Test fun screenshotsLight() = tour("light")
}
