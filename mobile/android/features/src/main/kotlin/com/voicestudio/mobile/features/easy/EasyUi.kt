package com.voicestudio.mobile.features.easy

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.intl.LocaleList
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voicestudio.mobile.designsystem.*
import com.voicestudio.mobile.features.*

/** JinVoice brand, the same blue-to-purple as the desktop easy mode. */
val EasyBrandStart = Color(0xFF5B6CFF)
val EasyBrandEnd = Color(0xFF8E5BFF)
val EasyBrand = Brush.linearGradient(listOf(EasyBrandStart, EasyBrandEnd))
val EasyCardShape = RoundedCornerShape(24.dp)
private val EasyTileShape = RoundedCornerShape(18.dp)

/** Small lucide-like glyphs the core Material set does not have. */
object EasyIcons {
    private fun symbol(name: String, data: String): ImageVector = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        .addPath(pathData = PathParser().parsePathString(data).toNodes(), fill = SolidColor(Color.White), pathFillType = PathFillType.EvenOdd).build()
    val Book by lazy { symbol("Book", "M2 4h7.5A2.5 2.5 0 0 1 12 6.2 2.5 2.5 0 0 1 14.5 4H22v15h-7.5a1.5 1.5 0 0 0-1.5 1.5h-2A1.5 1.5 0 0 0 9.5 19H2z M4 6v11h5.5a3.5 3.5 0 0 1 1.5.3V6.5A.5.5 0 0 0 10.5 6z M13 6.5v10.8a3.5 3.5 0 0 1 1.5-.3H20V6h-6.5a.5.5 0 0 0-.5.5z") }
    val History by lazy { symbol("History", "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M11 7h2v4.6l3.4 2-1 1.7L11 12.7z") }
    val Help by lazy { symbol("Help", "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M11 16h2v2h-2z M12 6a3.6 3.6 0 0 1 3.6 3.6c0 1.6-1 2.4-1.8 3-.5.4-.8.7-.8 1.4H11c0-1.5.8-2.2 1.5-2.7.6-.5 1.1-.9 1.1-1.7a1.6 1.6 0 0 0-3.2 0h-2A3.6 3.6 0 0 1 12 6z") }
    val Sliders by lazy { symbol("Sliders", "M3 6h10v2H3z M17 6h4v2h-4z M13 4h4v6h-4z M3 16h4v2H3z M11 16h10v2H11z M7 14h4v6H7z") }
    val Speaker by lazy { symbol("Speaker", "M3 9h4l5-4v14l-5-4H3z M15 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2z M17.8 5.7a9 9 0 0 1 0 12.6l-1.4-1.4a7 7 0 0 0 0-9.8z") }
    val Swap by lazy { symbol("Swap", "M7 3 2 8l5 5V9h11V7H7z M17 11v4H6v2h11v4l5-5z") }
}

fun easyIcon(id: String): ImageVector = when(id) {
    "create", "speak" -> VSIcons.Wave
    "book" -> EasyIcons.Book
    "voices" -> VSIcons.Mic
    "history" -> EasyIcons.Speaker
    "design" -> Icons.Default.Create
    "gallery" -> Icons.Default.Face
    "stories" -> Icons.Default.Person
    "dub" -> VSIcons.Video
    "batch" -> Icons.AutoMirrored.Filled.List
    "dictate" -> Icons.Default.Edit
    "transcriptions" -> Icons.Default.Email
    "workflows" -> Icons.Default.Share
    "projects" -> VSIcons.Folder
    "tools" -> Icons.Default.Build
    "handoff" -> EasyIcons.Swap
    "calls" -> Icons.Default.Call
    "local-api" -> VSIcons.Link
    else -> Icons.Default.Star
}

/** Scrolling page body for every easy screen: wide side margins, generous spacing, readable width. */
/** Korean reads best when lines break between words, not inside them; the same rule suits every language. */
@Composable fun EasyTextStyle(content: @Composable ()->Unit) {
    val locale = LocalL10n.current.locale
    ProvideTextStyle(LocalTextStyle.current.merge(TextStyle(lineBreak = LineBreak.Paragraph.copy(wordBreak = LineBreak.WordBreak.Phrase),
        localeList = LocaleList(locale))), content)
}

@Composable fun EasyPage(bottomBar: (@Composable ()->Unit)? = null, content: @Composable ColumnScope.()->Unit) = EasyTextStyle {
    Column(Modifier.fillMaxSize().imePadding().dismissKeyboardOnTap()) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp), content = content)
        }
        bottomBar?.let { bar -> Box(Modifier.widthIn(max = 640.dp).fillMaxWidth().align(Alignment.CenterHorizontally).padding(horizontal = 20.dp, vertical = 10.dp)) { bar() } }
    }
}

/** A rounded icon tile: solid brand gradient for the main action, a soft brand tint for the rest. */
@Composable fun EasyIconTile(icon: ImageVector, strong: Boolean, size: Dp = 60.dp) {
    val dark = isDarkRoles()
    Box(Modifier.size(size).clip(EasyTileShape).then(if(strong) Modifier.background(EasyBrand) else Modifier.background(EasyBrandStart.copy(alpha = if(dark) .22f else .12f))),
        contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(size * .5f), tint = if(strong) Color.White else easyAccent())
    }
}

@Composable fun easySwitchColors() = SwitchDefaults.colors(checkedTrackColor = EasyBrandStart, checkedThumbColor = Color.White, checkedBorderColor = EasyBrandStart,
    uncheckedTrackColor = role("messageSurface"), uncheckedThumbColor = role("textMuted"), uncheckedBorderColor = role("textMuted").copy(alpha = .6f))

@Composable fun isDarkRoles(): Boolean = role("canvas").let { (it.red + it.green + it.blue) / 3f < .5f }
/** Brand colour for text and small icons, lifted a little on dark backgrounds so it stays readable. */
@Composable fun easyAccent(): Color = if(isDarkRoles()) Color(0xFF9AA5FF) else EasyBrandStart

@Composable fun EasyCardSurface(onClick: (()->Unit)? = null, modifier: Modifier = Modifier, content: @Composable ColumnScope.()->Unit) {
    val border = BorderStroke(VSTheme.borderWidth, role("border"))
    if(onClick != null) Surface(onClick = onClick, modifier = modifier.fillMaxWidth(), shape = EasyCardShape, color = role("surface"), border = border, shadowElevation = 1.dp) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    } else Surface(modifier = modifier.fillMaxWidth(), shape = EasyCardShape, color = role("surface"), border = border) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

/** The main gradient button of an easy screen. */
@Composable fun EasyPrimaryButton(label: String, icon: ImageVector, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: ()->Unit) {
    val dismiss = rememberKeyboardDismiss()
    Button(onClick = { dismiss(); onClick() }, enabled = enabled, shape = CircleShape, contentPadding = PaddingValues(0.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, disabledContainerColor = role("messageSurface"), contentColor = Color.White, disabledContentColor = role("textMuted")),
        modifier = modifier.fillMaxWidth().heightIn(min = 60.dp)) {
        Box(Modifier.fillMaxWidth().heightIn(min = 60.dp).then(if(enabled) Modifier.background(EasyBrand, CircleShape) else Modifier), contentAlignment = Alignment.Center) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(horizontal = 20.dp)) {
                Icon(icon, null, Modifier.size(24.dp))
                Text(label, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** A quiet outlined button with an icon and a plain word. */
@Composable fun EasyButton(label: String, icon: ImageVector, enabled: Boolean = true, modifier: Modifier = Modifier, danger: Boolean = false, onClick: ()->Unit) {
    val dismiss = rememberKeyboardDismiss()
    OutlinedButton(onClick = { dismiss(); onClick() }, enabled = enabled, shape = CircleShape, modifier = modifier.heightIn(min = 52.dp),
        border = BorderStroke(VSTheme.borderWidth, role("border")), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = role("surface"), contentColor = if(danger) role("errorForeground") else role("text"))) {
        Icon(icon, null, Modifier.size(20.dp), tint = if(!enabled) role("textMuted") else if(danger) role("errorForeground") else easyAccent())
        Spacer(Modifier.width(8.dp))
        Text(label, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

@Composable fun EasyStepTitle(number: Int, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(30.dp).background(EasyBrand, CircleShape), contentAlignment = Alignment.Center) {
            Text(number.toString(), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }
        Text(text, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
    }
}

@Composable fun EasyNote(text: String, warning: Boolean = false) {
    Surface(shape = RoundedCornerShape(16.dp), color = if(warning) role("warningSurface") else EasyBrandStart.copy(alpha = if(isDarkRoles()) .16f else .08f), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(if(warning) Icons.Default.Warning else Icons.Default.Info, null, Modifier.size(20.dp), tint = if(warning) role("warningForeground") else easyAccent())
            Text(text, fontSize = 15.sp, lineHeight = 22.sp, color = if(warning) role("warningForeground") else role("text"))
        }
    }
}

@Composable fun EasyEmpty(icon: ImageVector, title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        EasyIconTile(icon, strong = false, size = 72.dp)
        Text(title, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Text(body, fontSize = 16.sp, color = role("textMuted"), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

// ---------------------------------------------------------------- Home

@Composable fun EasyHomeScreen(vm: StudioViewModel, navigate: (String)->Unit) {
    val prefs by vm.preferences.collectAsState()
    val phone by vm.phone.state.collectAsState()
    val host by vm.state.collectAsState()
    LaunchedEffect(Unit) {
        try { vm.phone.refresh() } catch(e: kotlinx.coroutines.CancellationException) { throw e } catch(e: Exception) { vm.fail(e) }
    }
    val cards = EasyFeatures.homeCards(prefs)
    EasyPage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp, bottom = 4.dp)) {
            Text(tr("easy.home_title"), fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
            Text(tr("mobile.easy.home_subtitle"), fontSize = 16.sp, lineHeight = 23.sp, color = role("textMuted"))
        }
        val voiceCount = phone.voices.size + host.profiles.size
        val takeCount = phone.recent.size + host.history.size
        EasyGrid(cards.filterNot { it.extra }) { card ->
            EasyBigCard(card, meta = when(card.id) {
                "voices" -> tr("easy.voice_count", mapOf("n" to voiceCount))
                "history" -> tr("easy.take_count", mapOf("n" to takeCount))
                else -> null
            }) { navigate(card.route) }
        }
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            TextButton(onClick = { navigate(EasyFeatures.FEATURES) }, shape = CircleShape, modifier = Modifier.heightIn(min = 48.dp).testTag("easy.more")) {
                Icon(EasyIcons.Sliders, null, Modifier.size(18.dp), tint = role("textMuted"))
                Spacer(Modifier.width(8.dp))
                Text(tr("easy.features_more"), fontSize = 15.sp, color = role("textMuted"))
            }
        }
        val extras = cards.filter { it.extra }
        if(extras.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(tr("easy.extra_title"), fontSize = 21.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                Text(tr("easy.extra_subtitle"), fontSize = 15.sp, color = role("textMuted"))
            }
            EasyGrid(extras) { card -> EasySmallCard(card) { navigate(card.route) } }
        }
    }
}

/** One column on a phone, two once the window is wide enough (unfolded, tablet, landscape). */
@Composable private fun EasyGrid(cards: List<EasyCard>, item: @Composable (EasyCard)->Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = if(maxWidth >= 560.dp) 2 else 1
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            cards.chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.height(IntrinsicSize.Max)) {
                    row.forEach { Box(Modifier.weight(1f).fillMaxHeight()) { item(it) } }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable private fun EasyBigCard(card: EasyCard, meta: String?, onClick: ()->Unit) {
    Surface(onClick = onClick, modifier = Modifier.fillMaxSize().testTag("easy.card.${card.id}"), shape = EasyCardShape, color = role("surface"),
        border = BorderStroke(VSTheme.borderWidth, role("border")), shadowElevation = 1.dp) {
        Row(Modifier.padding(20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            EasyIconTile(easyIcon(card.id), strong = card.id == "create")
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(tr(card.title), fontSize = 21.sp, lineHeight = 27.sp, fontWeight = FontWeight.SemiBold)
                Text(tr(card.detail), fontSize = 15.sp, lineHeight = 22.sp, color = role("textMuted"))
                Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(meta.orEmpty(), Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = role("textMuted"))
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(24.dp), tint = easyAccent())
                }
            }
        }
    }
}

@Composable private fun EasySmallCard(card: EasyCard, onClick: ()->Unit) {
    Surface(onClick = onClick, modifier = Modifier.fillMaxSize().testTag("easy.card.${card.id}"), shape = RoundedCornerShape(20.dp), color = role("surface"),
        border = BorderStroke(VSTheme.borderWidth, role("border"))) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            EasyIconTile(easyIcon(card.id), strong = false, size = 48.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(tr(card.title), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(tr(card.detail), fontSize = 14.sp, lineHeight = 20.sp, color = role("textMuted"))
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(22.dp), tint = easyAccent())
        }
    }
}

// ---------------------------------------------------------------- Feature switches

@Composable fun EasyFeaturesScreen(vm: StudioViewModel) {
    val prefs by vm.preferences.collectAsState()
    EasyPage {
        Text(tr("easy.features_desc"), fontSize = 16.sp, lineHeight = 23.sp, color = role("textMuted"))
        if(prefs.showAllFeatures) EasyNote(tr("easy.features_all_visible"))
        Text(tr("easy.features_on_count", mapOf("n" to EasyFeatures.enabled(prefs).size, "total" to EasyFeatures.all.size)),
            fontSize = 15.sp, fontWeight = FontWeight.Medium, color = easyAccent())
        EasyFeatures.all.forEach { feature ->
            val on = EasyFeatures.isOn(prefs, feature.id)
            val name = tr(feature.title)
            val state = tr(if(on) "easy.feature_on" else "easy.feature_off")
            Surface(onClick = { vm.preference { EasyFeatures.set(it, feature.id, !on) } }, shape = RoundedCornerShape(20.dp), color = role("surface"),
                border = BorderStroke(VSTheme.borderWidth, if(on) easyAccent().copy(alpha = .6f) else role("border")),
                modifier = Modifier.fillMaxWidth().testTag("easy.feature.${feature.id}").semantics(mergeDescendants = true) { stateDescription = state }) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    EasyIconTile(easyIcon(feature.id), strong = on, size = 48.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                        Text(tr(feature.detail), fontSize = 14.sp, lineHeight = 20.sp, color = role("textMuted"))
                    }
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Switch(checked = on, onCheckedChange = { value -> vm.preference { EasyFeatures.set(it, feature.id, value) } },
                            colors = easySwitchColors(),
                            modifier = Modifier.semantics { contentDescription = name })
                        Text(state, fontSize = 13.sp, color = if(on) easyAccent() else role("textMuted"), fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- Help

@Composable fun EasyHelpScreen(navigate: (String)->Unit) {
    EasyPage {
        Text(tr("easy.help_intro"), fontSize = 17.sp, lineHeight = 24.sp)
        HelpSection(VSIcons.Download, "mobile.easy.help_setup_title", listOf("mobile.easy.help_setup_1", "mobile.easy.help_setup_2", "mobile.easy.help_setup_3"), "easy.help_open_settings") { navigate("settings") }
        HelpSection(VSIcons.Wave, "easy.help_create_title", listOf("easy.help_create_1", "easy.help_create_2", "easy.help_create_3", "mobile.easy.help_create_4"), "easy.help_open") { navigate(EasyFeatures.CREATE) }
        HelpSection(VSIcons.Mic, "easy.help_voice_title", listOf("easy.help_voice_1", "easy.help_voice_2", "easy.help_voice_3"), "easy.help_open") { navigate(EasyFeatures.VOICES) }
        HelpSection(EasyIcons.Book, "easy.help_book_title", listOf("mobile.easy.help_book_1", "mobile.easy.help_book_2", "mobile.easy.help_book_3"), "easy.help_open") { navigate(EasyFeatures.BOOK) }
        HelpSection(EasyIcons.Speaker, "easy.help_history_title", listOf("easy.help_history_1", "easy.help_history_2"), "easy.help_open") { navigate(EasyFeatures.HISTORY) }
        HelpSection(EasyIcons.Sliders, "easy.help_more_title", listOf("mobile.easy.help_more_1", "mobile.easy.help_more_2", "mobile.easy.help_more_3"), "easy.features_manage") { navigate(EasyFeatures.FEATURES) }
    }
}

@Composable private fun HelpSection(icon: ImageVector, title: String, steps: List<String>, action: String, open: ()->Unit) {
    EasyCardSurface {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            EasyIconTile(icon, strong = false, size = 44.dp)
            Text(tr(title), fontSize = 19.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f).semantics { heading() })
        }
        steps.forEachIndexed { index, key ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(24.dp).background(EasyBrandStart.copy(alpha = if(isDarkRoles()) .3f else .14f), CircleShape), contentAlignment = Alignment.Center) {
                    Text((index + 1).toString(), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = easyAccent())
                }
                Text(tr(key, mapOf("max" to if(key == "easy.help_voice_3") EASY_MAX_SAMPLE_SECONDS else EASY_MAX_CHARS)), fontSize = 16.sp, lineHeight = 23.sp, modifier = Modifier.weight(1f))
            }
        }
        TextButton(onClick = open, shape = CircleShape, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(tr(action), fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = easyAccent())
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(20.dp), tint = easyAccent())
        }
    }
}

/** One take on the easy screen; longer text belongs in Read long text. */
const val EASY_MAX_CHARS = 1000
/** Longest voice sample the recorder keeps, matching the original Voices screen. */
const val EASY_MAX_SAMPLE_SECONDS = 29

