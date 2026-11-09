@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.voicestudio.mobile.features.easy

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.voicestudio.mobile.data.PhoneProductionWorker
import com.voicestudio.mobile.designsystem.*
import com.voicestudio.mobile.features.*
import com.voicestudio.mobile.features.models.MissingModelsCard
import com.voicestudio.mobile.local.*
import kotlinx.coroutines.*
import java.io.File

/** Prose without chapter lines is cut into parts of about this many characters, like the desktop easy audiobook. */
const val EASY_BOOK_PART_CHARS = 3000
private const val CHAPTER_TITLE_MAX = 60
private val HEADING = Regex("^[ \\t]*#[ \\t]+\\S", RegexOption.MULTILINE)
// "Chapter 3", "Part II", "Prologue" and the Korean chapter forms (je-N-jang/hwa/bu/pyeon/jeol, N-jang, prologue,
// epilogue, foreword, preface, afterword), written as escapes so the source stays ASCII.
private val CHAPTER_LINE = Regex("^(?:" + listOf(
    "\\uC81C\\s*\\d+\\s*[\\uC7A5\\uD654\\uBD80\\uD3B8\\uC808]", "\\d+\\s*[\\uC7A5\\uD654]", "chapter\\s+\\S+", "part\\s+\\S+", "prologue", "epilogue",
    "\\uD504\\uB864\\uB85C\\uADF8", "\\uC5D0\\uD544\\uB85C\\uADF8", "\\uC11C\\uBB38", "\\uBA38\\uB9AC\\uB9D0", "\\uB9FA\\uC74C\\uB9D0",
).joinToString("|") + ")(?=$|[\\s.:)\\]-])", RegexOption.IGNORE_CASE)
private val SENTENCE_END = Regex("(?<=[.!?\\u2026\\u3002\\uFF01\\uFF1F])\\s+")

/**
 * Turn pasted prose into the phone audiobook's chapter script (`# title` lines), the same rules as the desktop easy audiobook:
 * existing `# ` headings are kept; otherwise short "Chapter 3"-style lines become headings; otherwise the text is cut at
 * paragraph breaks into parts of about [partChars] characters so progress and resume work per part.
 */
fun easyBookScript(text: String, part: (Int)->String, intro: String, partChars: Int = EASY_BOOK_PART_CHARS): String {
    val normalized = text.replace("\r\n", "\n").replace('\r', '\n')
    if(normalized.isBlank()) return ""
    fun withIntro(script: String): String {
        val first = HEADING.find(script)?.range?.first ?: return script
        return if(first > 0 && script.substring(0, first).isNotBlank()) "# $intro\n$script" else script
    }
    if(HEADING.containsMatchIn(normalized)) return withIntro(normalized)
    var found = false
    val marked = normalized.split('\n').joinToString("\n") { line ->
        val trimmed = line.trim()
        if(trimmed.isNotEmpty() && trimmed.length <= CHAPTER_TITLE_MAX && CHAPTER_LINE.containsMatchIn(trimmed)) { found = true; "# $trimmed" } else line
    }
    if(found) return withIntro(marked)
    val paragraphs = normalized.split(Regex("\\n[ \\t]*\\n")).map { it.trim() }.filter { it.isNotEmpty() }.flatMap { paragraph ->
        if(paragraph.length <= partChars) listOf(paragraph) else {
            val pieces = mutableListOf<String>(); var current = ""
            paragraph.split('\n').flatMap { it.split(SENTENCE_END) }.filter { it.isNotBlank() }.forEach { sentence ->
                if(current.isNotEmpty() && current.length + sentence.length + 1 > partChars) { pieces += current; current = "" }
                current = if(current.isEmpty()) sentence else "$current $sentence"
            }
            if(current.isNotEmpty()) pieces += current
            pieces
        }
    }
    val parts = mutableListOf<MutableList<String>>(); var size = 0
    for(paragraph in paragraphs) {
        if(parts.isEmpty() || size + paragraph.length > partChars) { parts += mutableListOf(paragraph); size = paragraph.length }
        else { parts.last() += paragraph; size += paragraph.length }
    }
    return parts.mapIndexed { index, items -> "# ${part(index + 1)}\n${items.joinToString("\n\n")}" }.joinToString("\n\n")
}

private fun chooseBookModel(models: List<PhoneModel>, installed: Set<String>, choices: Map<String,String>, task: String, capability: String): PhoneModel? =
    models.filter { it.capability == capability }.let { options -> options.firstOrNull { it.id == choices[task] } ?: options.firstOrNull { it.id in installed } ?: options.firstOrNull() }

/** Read long text: paste or open a text, pick a voice and speed, make one audiobook on the phone, then listen, save or share. */
@Composable fun EasyBookScreen(vm: StudioViewModel, onVoices: ()->Unit) {
    val phone by vm.phone.state.collectAsState()
    val prefs by vm.preferences.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val manager = remember(context) { WorkManager.getInstance(context) }
    val partLabel = LocalL10n.current
    var title by rememberSaveable { mutableStateOf("") }
    var text by rememberSaveable { mutableStateOf("") }
    var choice by rememberSaveable { mutableStateOf<String?>(null) }
    var speed by rememberSaveable { mutableStateOf(EasySpeed.NORMAL) }
    var projectId by rememberSaveable { mutableStateOf<String?>(null) }
    var project by remember { mutableStateOf<ProductionProject?>(null) }
    var output by remember { mutableStateOf<File?>(null) }
    var chapters by remember { mutableStateOf(emptyList<File>()) }
    var playing by remember { mutableStateOf<File?>(null) }
    var exporting by remember { mutableStateOf(false) }
    var pendingSave by remember { mutableStateOf<File?>(null) }
    val saveMp3 = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/mpeg")) { uri -> copyTo(context, scope, vm, uri, pendingSave); pendingSave = null }
    val saveWav = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/wav")) { uri -> copyTo(context, scope, vm, uri, pendingSave); pendingSave = null }
    val importer = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if(uri != null) scope.launch {
        try {
            val loaded = withContext(Dispatchers.IO) {
                val extension = when(context.contentResolver.getType(uri)) { "application/epub+zip" -> "epub"; "application/pdf" -> "pdf"; else -> "txt" }
                val source = copyMedia(context, uri, extension, maxBytes = 67_108_864L)
                try { BookImport.read(source, context) } finally { source.delete() }
            }
            text = loaded
            if(title.isBlank()) title = mediaDisplayName(context, uri)?.substringBeforeLast('.').orEmpty()
        } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) }
    } }
    LaunchedEffect(phone.voices) {
        if(choice == null || (choice!!.startsWith("phone:") && phone.voices.none { "phone:" + it.id == choice }))
            choice = phone.voices.firstOrNull()?.let { "phone:" + it.id } ?: "preset:0"
    }
    // Come back to the latest audiobook so a book still being made (or finished) is shown, not lost.
    LaunchedEffect(Unit) {
        try {
            vm.phone.refresh()
            val saved = vm.phone.production.list().filter { it.kind == "audiobook" }
            val latest = (projectId?.let { id -> saved.firstOrNull { it.id == id } } ?: saved.maxByOrNull { it.modifiedAt })
            if(latest != null && project == null) {
                project = latest; projectId = latest.id
                if(text.isBlank()) text = latest.script
                if(title.isBlank()) title = latest.title
            }
        } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) }
    }
    val voice = phone.voices.firstOrNull { "phone:" + it.id == choice }
    val tts = chooseBookModel(phone.models, phone.installed, prefs.phoneModels, "production-tts", "tts")
    val clone = chooseBookModel(phone.models, phone.installed, prefs.phoneModels, "production-clone", "clone")
    val configuration = listOfNotNull(tts, clone).joinToString("|") { modelPin(it).identity }
    val needed = listOfNotNull(if(voice == null) tts else clone)
    val speakers = tts?.option("num_speakers", "1")?.toIntOrNull()?.coerceIn(1, 128) ?: 1
    val script = remember(text) { easyBookScript(text, { partLabel.t("easy.book_part", mapOf("n" to it)) }, partLabel.t("easy.book_intro")) }
    val plan = remember(script) { runCatching { ProductionPlan.parse(script) }.getOrNull() }
    val unreadable = voice == null && basicCannotRead(tts, text)
    val jobs by remember(projectId) { manager.getWorkInfosByTagFlow("production:${projectId.orEmpty()}") }.collectAsState(initial = emptyList())
    val active = jobs.firstOrNull { !it.state.isFinished }
    val running = active != null
    val percent = active?.progress?.getInt("percent", 0) ?: 0
    val failed = !running && jobs.any { it.state == WorkInfo.State.FAILED } && output == null
    LaunchedEffect(project, configuration, jobs) {
        val current = project ?: return@LaunchedEffect
        if(running) return@LaunchedEffect
        try {
            output = vm.phone.production.output(current, configuration)
            chapters = if(output != null) vm.phone.production.chapterOutputs(current, configuration) else emptyList()
        } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) }
    }
    fun fresh() { project = null; projectId = null; output = null; chapters = emptyList(); playing = null; text = ""; title = "" }
    EasyPage {
        if(output == null && !running) {
            EasyStepTitle(1, tr("easy.book_step_text"))
            OutlinedTextField(title, { title = it.take(200) }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text(tr("easy.book_title_placeholder")) },
                shape = RoundedCornerShape(16.dp), textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 18.sp),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = EasyBrandStart, unfocusedBorderColor = role("border"), focusedContainerColor = role("surface"), unfocusedContainerColor = role("surface")))
            EasyButton(tr("easy.book_open_file"), VSIcons.Folder, modifier = Modifier.fillMaxWidth()) { importer.launch(arrayOf("text/plain", "application/epub+zip", "application/pdf")) }
            OutlinedTextField(value = text, onValueChange = { text = it }, modifier = Modifier.fillMaxWidth().testTag("easy.book.text"), minLines = 7, maxLines = 14,
                placeholder = { Text(tr("easy.book_text_placeholder"), fontSize = 17.sp) }, textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp, lineHeight = 26.sp),
                shape = RoundedCornerShape(20.dp), colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = EasyBrandStart, unfocusedBorderColor = role("border"),
                    focusedContainerColor = role("surface"), unfocusedContainerColor = role("surface")))
            Text(tr("easy.book_char_count", mapOf("n" to text.length)), fontSize = 14.sp, color = role("textMuted"), modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.End)
            EasyCardSurface {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(tr("easy.book_preview_title"), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    plan?.let { Text(tr("easy.book_preview_count", mapOf("n" to it.chapters.size)), fontSize = 15.sp, color = easyAccent(), fontWeight = FontWeight.Medium) }
                }
                if(plan == null) Text(tr("easy.book_preview_empty"), fontSize = 15.sp, color = role("textMuted"))
                else plan.chapters.take(6).forEachIndexed { index, name ->
                    Text("${index + 1}. ${name.ifBlank { tr("easy.book_part", mapOf("n" to index + 1)) }}", fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if((plan?.chapters?.size ?: 0) > 6) Text("…", color = role("textMuted"))
                Text(tr("easy.book_split_hint", mapOf("n" to EASY_BOOK_PART_CHARS)), fontSize = 13.sp, lineHeight = 19.sp, color = role("textMuted"))
            }
            EasyStepTitle(2, tr("easy.step_voice"))
            val choices = phone.voices.map { Choice("phone:" + it.id, it.name, supporting = tr("easy.my_voice")) } +
                (0 until speakers).map { Choice("preset:$it", tr("mobile.easy.basic_voice", mapOf("n" to it + 1)), supporting = tr("easy.builtin_voice")) }
            Group { ChoicePicker("easy.step_voice", choice ?: "preset:0", choices, tile = true) { choice = it } }
            if(phone.voices.isEmpty()) {
                EasyNote(tr("mobile.easy.basic_language_note"), warning = unreadable)
                EasyButton(tr("easy.register_voice"), Icons.Default.Add, onClick = onVoices)
            } else if(unreadable) EasyNote(tr("mobile.easy.basic_language_note"), warning = true)
            EasyStepTitle(3, tr("easy.step_speed"))
            SpeedPicker(speed, enabled = voice == null) { speed = it }
            if(voice != null) Text(tr("mobile.easy.my_voice_speed_note"), fontSize = 14.sp, color = role("textMuted"))
            if(needed.any { !phone.canRun(it, vm.phone.ramBytes) }) {
                EasyNote(tr("easy.setup_needed_title") + "\n" + tr("mobile.easy.download_body"))
                MissingModelsCard(vm, "easy.audiobook_title_short", needed)
            }
            if(failed) EasyNote(tr("easy.book_error_title") + "\n" + tr("easy.book_retry_hint"), warning = true)
            EasyPrimaryButton(tr(if(failed) "easy.book_retry" else "easy.book_start"), EasyIcons.Book,
                enabled = plan != null && !unreadable && needed.isNotEmpty() && needed.all { phone.canRun(it, vm.phone.ramBytes) }) {
                val next = (project ?: ProductionProject(kind = "audiobook", title = "")).copy(
                    title = title.trim().ifBlank { partLabel.t("easy.book_untitled") }, script = script,
                    defaultVoice = choice ?: "preset:0", speed = if(voice == null) speed.factor else 1f, modifiedAt = System.currentTimeMillis())
                project = next; projectId = next.id
                scope.launch {
                    try { vm.phone.production.save(next); PhoneProductionWorker.enqueue(context, next, tts, clone) }
                    catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) }
                }
            }
        }
        if(running) EasyCardSurface(modifier = Modifier.testTag("easy.book.running")) {
            Text(tr("easy.book_making"), fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
            Text(project?.title.orEmpty(), fontSize = 15.sp, color = role("textMuted"), maxLines = 1, overflow = TextOverflow.Ellipsis)
            LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth(), color = EasyBrandStart)
            Text("$percent%", fontSize = 15.sp, fontWeight = FontWeight.Medium, color = easyAccent())
            Text(tr("easy.book_keep_going"), fontSize = 14.sp, lineHeight = 20.sp, color = role("textMuted"))
            EasyButton(tr("easy.book_stop"), VSIcons.Stop) { active?.let { manager.cancelWorkById(it.id) } }
        }
        val finished = output
        if(finished != null && !running) {
            EasyCardSurface(modifier = Modifier.testTag("easy.book.done")) {
                Text(tr("easy.book_done_title"), fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                Text(project?.title.orEmpty(), fontSize = 15.sp, color = role("textMuted"))
                LocalAudioPlayer(finished, vm::fail)
                EasyPrimaryButton(tr("easy.book_save_all"), VSIcons.Download, enabled = !exporting) {
                    val current = project ?: return@EasyPrimaryButton
                    exporting = true
                    scope.launch {
                        try { val mp3 = BookExport.encode(finished, "mp3", vm.phone.production.chapterCues(current, configuration)); pendingSave = mp3; saveMp3.launch(current.title + ".mp3") }
                        catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) } finally { exporting = false }
                    }
                }
                if(exporting) LinearProgressIndicator(Modifier.fillMaxWidth(), color = EasyBrandStart)
                EasyButton(tr("mobile.speak.share"), Icons.Default.Share, enabled = !exporting, modifier = Modifier.fillMaxWidth()) {
                    val current = project ?: return@EasyButton
                    exporting = true
                    scope.launch {
                        try { shareLocalFile(context, BookExport.encode(finished, "mp3", vm.phone.production.chapterCues(current, configuration)), "audio/mpeg") }
                        catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) } finally { exporting = false }
                    }
                }
            }
            if(chapters.size > 1) {
                Text(tr("easy.book_chapters_title"), fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                chapters.forEachIndexed { index, chapter ->
                    EasyCardSurface {
                        Text(tr("easy.book_part", mapOf("n" to index + 1)) + (project?.plan()?.chapters?.getOrNull(index)?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                            fontSize = 17.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            EasyButton(tr(if(playing == chapter) "easy.stop" else "easy.book_play_chapter"), if(playing == chapter) VSIcons.Stop else Icons.Default.PlayArrow) {
                                playing = if(playing == chapter) null else chapter
                            }
                            EasyButton(tr("easy.book_save_chapter"), VSIcons.Download) { pendingSave = chapter; saveWav.launch("${project?.title ?: "JinVoice"}-${index + 1}.wav") }
                        }
                        if(playing == chapter) LocalAudioPlayer(chapter, vm::fail)
                    }
                }
            }
            EasyButton(tr("easy.book_new"), Icons.Default.Add, modifier = Modifier.fillMaxWidth()) { fresh() }
        }
    }
}

private fun copyTo(context: android.content.Context, scope: CoroutineScope, vm: StudioViewModel, uri: android.net.Uri?, source: File?) {
    if(uri == null || source == null) return
    scope.launch {
        try { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)!!.use { out -> source.inputStream().use { it.copyTo(out) } } } }
        catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) }
    }
}
