package com.voicestudio.mobile.features.easy

import com.voicestudio.mobile.data.Preferences

/** A card on the easy home: one of the four basics, or an original screen the user switched on. */
data class EasyCard(val id: String, val route: String, val title: String, val detail: String, val extra: Boolean = false)

/** One original screen that "Turn features on and off" can add to the easy home. */
data class EasyFeature(val id: String, val route: String, val title: String, val detail: String,
    /** Screens this one opens by itself (history, a picked voice, a project), so they stay reachable once it is on. */
    val opens: List<String> = emptyList())

/**
 * The easy mode rules, kept free of Compose so they can be unit tested.
 * Nothing here removes a screen: every original route stays in the navigation graph,
 * easy mode only decides which ones the easy home shows and lets the user open.
 */
object EasyFeatures {
    const val HOME = "easy"
    const val CREATE = "easy/create"
    const val VOICES = "easy/voices"
    const val HISTORY = "easy/history"
    const val HELP = "easy/help"
    const val FEATURES = "easy/features"
    /** Read long text: a plain front for the phone's own audiobook engine (the original screen stays as "Audiobook (advanced)"). */
    const val BOOK = "easy/book"

    val basics = listOf(
        EasyCard("create", CREATE, "easy.create_title", "easy.create_card"),
        EasyCard("book", BOOK, "easy.audiobook_title_short", "easy.audiobook_card"),
        EasyCard("voices", VOICES, "easy.voices_title", "easy.voices_card"),
        EasyCard("history", HISTORY, "easy.history_title", "easy.history_card"),
    )

    val all = listOf(
        EasyFeature("speak", "speak", "mobile.easy.speak_title", "mobile.easy.speak_desc", listOf("voice/", "host-voice/", "preset/")),
        EasyFeature("voices", "voices", "easy.feature_clone", "easy.feature_clone_desc"),
        EasyFeature("design", "design", "easy.feature_design", "easy.feature_design_desc"),
        EasyFeature("gallery", "gallery", "easy.feature_gallery", "easy.feature_gallery_desc", listOf("preset/", "voice/", "host-voice/")),
        EasyFeature("stories", "stories", "easy.feature_stories", "easy.feature_stories_desc"),
        EasyFeature("audiobook", "audiobook", "easy.feature_audiobook", "easy.feature_audiobook_desc"),
        EasyFeature("dub", "dub", "easy.feature_dub", "easy.feature_dub_desc", listOf("host-dubs", "project/", "projects")),
        EasyFeature("batch", "batch", "easy.feature_batch", "easy.feature_batch_desc"),
        EasyFeature("dictate", "dictate", "mobile.easy.dictate_title", "mobile.easy.dictate_desc", listOf("transcriptions")),
        EasyFeature("transcriptions", "transcriptions", "easy.feature_transcriptions", "easy.feature_transcriptions_desc", listOf("dictate")),
        EasyFeature("workflows", "workflows", "easy.feature_calls", "easy.feature_calls_desc"),
        EasyFeature("projects", "projects", "easy.feature_projects", "easy.feature_projects_desc", listOf("project/")),
        EasyFeature("tools", "tools", "easy.feature_tools", "easy.feature_tools_desc"),
        EasyFeature("handoff", "handoff", "mobile.easy.handoff_title", "mobile.easy.handoff_desc"),
        EasyFeature("calls", "calls", "mobile.easy.calls_title", "mobile.easy.calls_desc"),
        EasyFeature("local-api", "local-api", "easy.feature_integrations", "easy.feature_integrations_desc", listOf("voices")),
    )
    private val ids = all.map { it.id }.toSet()

    /** Screens easy mode always needs: its own pages, settings, model downloads, computer pairing and shared files. */
    private val alwaysOpen = setOf("settings", "models", "connect", "incoming")

    fun easyMode(prefs: Preferences) = !prefs.showAllFeatures
    fun isOn(prefs: Preferences, id: String) = id in prefs.enabledFeatures && id in ids
    fun enabled(prefs: Preferences): List<EasyFeature> = all.filter { it.id in prefs.enabledFeatures }

    /** Switch one feature; unknown ids are ignored so a stale preference never shows a dead card. */
    fun set(prefs: Preferences, id: String, on: Boolean): Preferences {
        if(id !in ids) return prefs
        val next = if(on) prefs.enabledFeatures + id else prefs.enabledFeatures - id
        return prefs.copy(enabledFeatures = next.filter { it in ids }.toSet())
    }

    fun showAll(prefs: Preferences, on: Boolean) = prefs.copy(showAllFeatures = on)

    /** The easy home in order: the four basics, then each switched-on feature in list order. */
    fun homeCards(prefs: Preferences): List<EasyCard> =
        basics + enabled(prefs).map { EasyCard(it.id, it.route, it.title, it.detail, extra = true) }

    /** Whether easy mode may show [route]; switched-off features and their sub-screens are not reachable. */
    fun allowed(route: String, prefs: Preferences): Boolean {
        if(route == HOME || route.startsWith("$HOME/") || route in alwaysOpen) return true
        return enabled(prefs).any { feature ->
            route == feature.route || feature.opens.any { open -> if(open.endsWith("/")) route.startsWith(open) else route == open }
        }
    }

    /** Where a launcher shortcut or link for [route] lands in easy mode. */
    fun entry(route: String, prefs: Preferences): String = when {
        allowed(route, prefs) -> route
        route == "speak" -> CREATE
        else -> HOME
    }
}
