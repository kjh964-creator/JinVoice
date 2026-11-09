@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.voicestudio.mobile.features.easy

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.voicestudio.mobile.designsystem.*
import com.voicestudio.mobile.features.*
import com.voicestudio.mobile.features.models.MissingModelsCard
import com.voicestudio.mobile.features.models.TaskLocation
import com.voicestudio.mobile.features.speak.chooseSpeakModel
import com.voicestudio.mobile.local.PhoneModel
import com.voicestudio.mobile.local.PhoneVoice
import com.voicestudio.mobile.local.RunLocation
import com.voicestudio.mobile.network.HistoryItem
import com.voicestudio.mobile.network.Profile
import kotlinx.coroutines.*
import java.io.File

/** Speaking speeds offered on the easy screen; the engines accept 0.5x to 2x. */
enum class EasySpeed(val key: String, val factor: Float) { SLOW("easy.speed_slow", .8f), NORMAL("easy.speed_normal", 1f), FAST("easy.speed_fast", 1.25f) }

private val HANGUL = Regex("[\\u1100-\\u11FF\\u3130-\\u318F\\uAC00-\\uD7A3]")
private val HAN = Regex("[\\u4E00-\\u9FFF]")

/** The basic (preset) voices read only the languages their model lists; pick one that fits the text. */
internal fun basicLanguage(model: PhoneModel?, text: String): String? {
    val languages = model?.languages.orEmpty()
    return if(HAN.containsMatchIn(text) && "zh" in languages) "zh" else languages.firstOrNull()
}
/** True when the text is in a language the basic voices cannot read (e.g. Korean). */
internal fun basicCannotRead(model: PhoneModel?, text: String): Boolean = model != null && "ko" !in model.languages && HANGUL.containsMatchIn(text)

@Composable internal fun SpeedPicker(speed: EasySpeed, enabled: Boolean, change: (EasySpeed)->Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        EasySpeed.entries.forEachIndexed { index, value ->
            SegmentedButton(selected = speed == value, enabled = enabled, onClick = { change(value) }, shape = SegmentedButtonDefaults.itemShape(index, EasySpeed.entries.size),
                colors = SegmentedButtonDefaults.colors(activeContainerColor = EasyBrandStart.copy(alpha = if(isDarkRoles()) .35f else .16f), activeContentColor = role("text"),
                    inactiveContainerColor = role("surface"), activeBorderColor = role("border"), inactiveBorderColor = role("border")),
                modifier = Modifier.heightIn(min = 52.dp)) { Text(tr(value.key), fontSize = 16.sp) }
        }
    }
}

@Composable private fun TextBox(text: String, change: (String)->Unit) {
    OutlinedTextField(value = text, onValueChange = change, modifier = Modifier.fillMaxWidth().testTag("easy.text"), minLines = 5,
        placeholder = { Text(tr("easy.text_placeholder"), fontSize = 17.sp) }, textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 18.sp, lineHeight = 27.sp),
        shape = RoundedCornerShape(20.dp), colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = EasyBrandStart, unfocusedBorderColor = role("border"),
            focusedContainerColor = role("surface"), unfocusedContainerColor = role("surface")))
    val over = text.length > EASY_MAX_CHARS
    Text(tr(if(over) "easy.too_long" else "easy.char_count", mapOf("n" to text.length, "max" to EASY_MAX_CHARS)), fontSize = 14.sp,
        color = if(over) role("errorForeground") else role("textMuted"), modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.End)
}

/** Save a local file through the system "save as" picker, or share it with another app. */
@Composable private fun rememberSaveFile(vm: StudioViewModel): (File, String)->Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<File?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/wav")) { uri ->
        val source = pending; pending = null
        if(uri != null && source != null) scope.launch {
            try { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)!!.use { out -> source.inputStream().use { it.copyTo(out) } } } }
            catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) }
        }
    }
    return { file, name -> pending = file; save.launch(name) }
}

private fun fileName(text: String) = text.trim().take(24).replace(Regex("[\\\\/:*?\"<>|\\s]+"), "_").ifBlank { "JinVoice" } + ".wav"

// ---------------------------------------------------------------- Make speech

@Composable fun EasyCreateScreen(vm: StudioViewModel, onVoices: ()->Unit, onBook: ()->Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    TaskLocation(vm, "speak", setOf("tts", "clone")) { location, _ ->
        if(location == RunLocation.COMPUTER) EasyCreateComputer(vm, text, { text = it }, onBook)
        else EasyCreatePhone(vm, text, { text = it }, onVoices, onBook)
    }
}

@Composable private fun EasyCreatePhone(vm: StudioViewModel, text: String, change: (String)->Unit, onVoices: ()->Unit, onBook: ()->Unit) {
    val phone by vm.phone.state.collectAsState()
    val prefs by vm.preferences.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val saveFile = rememberSaveFile(vm)
    var choice by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(phone.voices) {
        if(choice == null || (choice!!.startsWith("phone:") && phone.voices.none { "phone:" + it.id == choice }))
            choice = phone.voices.firstOrNull()?.let { "phone:" + it.id } ?: "basic:0"
    }
    val voice = phone.voices.firstOrNull { "phone:" + it.id == choice }
    val capability = if(voice == null) "tts" else "clone"
    val model = chooseSpeakModel(phone.models, phone.installed, prefs.phoneModels, capability)
    val speakers = model?.option("num_speakers", model.option("speaker_count", "1"))?.toIntOrNull()?.coerceIn(1, 128) ?: 1
    val basic = choice?.removePrefix("basic:")?.toIntOrNull()?.takeIf { it in 0 until speakers } ?: 0
    var speed by rememberSaveable { mutableStateOf(EasySpeed.NORMAL) }
    var madeHere by rememberSaveable { mutableStateOf(false) }
    val ready = model != null && phone.canRun(model, vm.phone.ramBytes)
    val unreadable = voice == null && basicCannotRead(model, text)
    DisposableEffect(Unit) { onDispose { vm.phone.cancelInference() } }
    EasyPage {
        EasyStepTitle(1, tr("easy.step_voice"))
        val choices = phone.voices.map { Choice("phone:" + it.id, it.name, supporting = tr("easy.my_voice")) } +
            (0 until speakers).map { Choice("basic:$it", tr("mobile.easy.basic_voice", mapOf("n" to it + 1)), supporting = tr("easy.builtin_voice")) }
        Group { ChoicePicker("easy.step_voice", choice ?: "basic:0", choices, tile = true) { choice = it; madeHere = false } }
        if(phone.voices.isEmpty()) {
            if(!unreadable) EasyNote(tr("mobile.easy.basic_language_note"))
            EasyButton(tr("easy.register_voice"), Icons.Default.Add, onClick = onVoices)
        }
        EasyStepTitle(2, tr("easy.step_text"))
        TextBox(text) { change(it); madeHere = false }
        if(text.length > EASY_MAX_CHARS) TextButton(onClick = onBook) { Text(tr("easy.long_text_hint"), color = easyAccent()) }
        if(unreadable) EasyNote(tr("mobile.easy.basic_language_note"), warning = true)
        EasyStepTitle(3, tr("easy.step_speed"))
        SpeedPicker(speed, enabled = voice == null) { speed = it }
        if(voice != null) Text(tr("mobile.easy.my_voice_speed_note"), fontSize = 14.sp, color = role("textMuted"))
        if(model != null && !ready) {
            EasyNote(tr("easy.setup_needed_title") + "\n" + tr("mobile.easy.download_body"))
            MissingModelsCard(vm, "easy.create_title", listOf(model))
        }
        val progress = phone.progress
        if(progress != null) EasyCardSurface {
            Text(tr("easy.making"), fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth(), color = EasyBrandStart)
            Text(tr("easy.making_first_time"), fontSize = 14.sp, color = role("textMuted"))
            EasyButton(tr("easy.cancel"), Icons.Default.Close) { vm.phone.cancelInference() }
        } else EasyPrimaryButton(tr("easy.create_button"), VSIcons.Wave,
            enabled = text.isNotBlank() && text.length <= EASY_MAX_CHARS && ready && !unreadable) {
            madeHere = true
            vm.phone.speak(model!!, text, basic, voice, if(voice == null) basicLanguage(model, text) else null, if(voice == null) speed.factor else 1f)
        }
        val audio = phone.audio
        if(madeHere && progress == null && audio != null) EasyResult(vm, audio, onSave = { saveFile(audio, fileName(text)) },
            onShare = { scope.launch { try { shareLocalFile(context, audio, "audio/wav") } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) } } })
    }
}

@Composable private fun EasyResult(vm: StudioViewModel, file: File?, hostPath: String? = null, onSave: ()->Unit, onShare: ()->Unit) {
    EasyCardSurface(modifier = Modifier.testTag("easy.result")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(32.dp).background(EasyBrand, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Default.Check, null, Modifier.size(20.dp), tint = Color.White) }
            Text(tr("easy.result_title"), fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
        }
        if(file != null) LocalAudioPlayer(file, vm::fail)
        else if(hostPath != null) vm.api?.let { HostPlayer(it, hostPath, vm::fail) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            EasyButton(tr("easy.save_short"), VSIcons.Download, modifier = Modifier.weight(1f), onClick = onSave)
            EasyButton(tr("mobile.speak.share"), Icons.Default.Share, modifier = Modifier.weight(1f), onClick = onShare)
        }
    }
}

@Composable private fun EasyCreateComputer(vm: StudioViewModel, text: String, change: (String)->Unit, onBook: ()->Unit) {
    val state by vm.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val saveFile = rememberSaveFile(vm)
    val l = LocalL10n.current
    val catalog = rememberLanguageCatalog(vm::fail)
    var voice by rememberSaveable { mutableStateOf("") }
    var speed by rememberSaveable { mutableStateOf(EasySpeed.NORMAL) }
    var madeHere by rememberSaveable { mutableStateOf(false) }
    val profile = state.profiles.firstOrNull { it.id == voice }
    val engines = engineChoices(state.engines, profile) { l.t(it) }
    val engine = initialEngine(state.engines, engines)
    LaunchedEffect(state.profiles) { if(voice.isNotBlank() && profile == null) voice = "" }
    EasyPage {
        EasyStepTitle(1, tr("easy.step_voice"))
        Group { ChoicePicker("easy.step_voice", voice, tile = true, choices = listOf(Choice("", tr("easy.builtin_voice"))) + state.profiles.map { Choice(it.id, it.name, supporting = tr("easy.my_voice")) }) { voice = it; madeHere = false } }
        EasyStepTitle(2, tr("easy.step_text"))
        TextBox(text) { change(it); madeHere = false }
        if(text.length > EASY_MAX_CHARS) TextButton(onClick = onBook) { Text(tr("easy.long_text_hint"), color = easyAccent()) }
        EasyStepTitle(3, tr("easy.step_speed"))
        SpeedPicker(speed, enabled = true) { speed = it }
        if(state.catalogLoading || catalog == null) Text(tr("easy.loading"), color = role("textMuted"))
        if(state.busy) EasyCardSurface {
            Text(tr("easy.making"), fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            LinearProgressIndicator(Modifier.fillMaxWidth(), color = EasyBrandStart)
            EasyButton(tr("easy.cancel"), Icons.Default.Close) { vm.cancel() }
        } else EasyPrimaryButton(tr("easy.create_button"), VSIcons.Wave, enabled = text.isNotBlank() && text.length <= EASY_MAX_CHARS && engine.isNotBlank() && catalog != null) {
            madeHere = true
            vm.generate(text, voice, engine, catalog?.preferred(profile) ?: "Auto", speed.factor)
        }
        val audio = state.audio; val api = vm.api
        if(madeHere && !state.busy && audio != null && api != null) EasyResult(vm, null, audio,
            onSave = { scope.launch { try { saveFile(sharedDownload(context, api, audio, "wav"), fileName(text)) } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) } } },
            onShare = { vm.run { shareFile(context, sharedDownload(context, api, audio, "wav"), "audio/wav") } })
    }
}

// ---------------------------------------------------------------- My voices

@Composable fun EasyVoicesScreen(vm: StudioViewModel) {
    TaskLocation(vm, "clone", setOf("clone"), dependencies = setOf("asr")) { location, model -> EasyVoicesContent(vm, location, model) }
}

@Composable private fun EasyVoicesContent(vm: StudioViewModel, location: RunLocation, model: PhoneModel?) {
    val state by vm.state.collectAsState()
    val phone by vm.phone.state.collectAsState()
    val preferences by vm.preferences.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val saveFile = rememberSaveFile(vm)
    var registering by rememberSaveable { mutableStateOf(false) }
    var playing by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Profile?>(null) }
    var renameText by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf<Profile?>(null) }
    val profiles = phone.voices.map { Profile("phone:" + it.id, it.name, audioUrl = it.id) } + state.profiles
    fun local(profile: Profile): PhoneVoice? = phone.voices.firstOrNull { "phone:" + it.id == profile.id }
    if(registering) {
        val asr = phone.models.filter { it.capability == "asr" }.let { items -> items.firstOrNull { it.id == preferences.phoneModels["clone-asr"] } ?: items.firstOrNull { phone.canRun(it, vm.phone.ramBytes) } ?: items.firstOrNull() }
        EasyRegisterVoice(vm, location, model, asr) { registering = false }
        return
    }
    EasyPage {
        EasyPrimaryButton(tr("easy.register_voice"), Icons.Default.Add, enabled = !state.busy && phone.progress == null) { registering = true }
        if(profiles.isEmpty() && !state.catalogLoading) EasyEmpty(VSIcons.Mic, tr("easy.no_voices_title"), tr("easy.no_voices_body"))
        if(state.catalogLoading) Text(tr("easy.loading"), color = role("textMuted"))
        profiles.forEach { profile ->
            val phoneVoice = local(profile)
            EasyCardSurface(modifier = Modifier.testTag("easy.voice.${profile.id}")) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Box(Modifier.size(48.dp).background(EasyBrand, CircleShape), contentAlignment = Alignment.Center) {
                        Text(profile.name.take(1).uppercase(), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    }
                    Column(Modifier.weight(1f)) {
                        Text(profile.name, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(tr(if(phoneVoice != null) "mobile.local.this_phone" else "mobile.local.my_computer"), fontSize = 14.sp, color = role("textMuted"))
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val isPlaying = playing == profile.id
                    EasyButton(tr(if(isPlaying) "easy.stop" else "easy.listen"), if(isPlaying) VSIcons.Stop else Icons.Default.PlayArrow, enabled = profile.audioUrl != null) {
                        playing = if(isPlaying) null else profile.id
                    }
                    EasyButton(tr("easy.rename"), Icons.Default.Edit, enabled = !state.busy) { renaming = profile; renameText = profile.name }
                    EasyButton(tr("mobile.easy.save_voice_file"), VSIcons.Download, enabled = profile.audioUrl != null) {
                        if(phoneVoice != null) saveFile(vm.phone.voices.preview(phoneVoice), fileName(profile.name))
                        else vm.api?.let { api -> profile.audioUrl?.let { path -> scope.launch {
                            try { saveFile(sharedDownload(context, api, path, "wav"), fileName(profile.name)) } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) }
                        } } }
                    }
                    EasyButton(tr("easy.delete"), Icons.Default.Delete, enabled = !state.busy, danger = true) { deleting = profile }
                }
                if(playing == profile.id) {
                    if(phoneVoice != null) LocalAudioPlayer(vm.phone.voices.preview(phoneVoice), vm::fail)
                    else vm.api?.let { api -> profile.audioUrl?.let { HostPlayer(api, it, vm::fail) } }
                }
            }
        }
    }
    renaming?.let { profile ->
        AlertDialog(shape = EasyCardShape, onDismissRequest = { renaming = null }, title = { Text(tr("easy.rename_title")) },
            text = { OutlinedTextField(renameText, { renameText = it.take(200) }, label = { Text(tr("easy.voice_name")) }, singleLine = true, shape = RoundedCornerShape(16.dp)) },
            confirmButton = { TextButton(enabled = renameText.isNotBlank(), onClick = {
                val voice = local(profile); if(voice != null) vm.phone.renameVoice(voice, renameText.trim()) else vm.rename(profile.id, renameText.trim()); renaming = null
            }) { Text(tr("easy.save")) } },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text(tr("easy.cancel")) } })
    }
    deleting?.let { profile ->
        AlertDialog(shape = EasyCardShape, onDismissRequest = { deleting = null }, title = { Text(tr("easy.delete_voice_title", mapOf("name" to profile.name))) },
            text = { Text(tr("easy.delete_voice_body")) },
            confirmButton = { TextButton(onClick = {
                val voice = local(profile); if(voice != null) vm.phone.deleteVoice(voice) else vm.deleteProfile(profile.id)
                if(playing == profile.id) playing = null; deleting = null
            }) { Text(tr("easy.delete"), color = role("errorForeground")) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text(tr("easy.cancel")) } })
    }
}

/** Name, record or pick a sample, agree, save: the original clone flow with plain words. */
@Composable private fun EasyRegisterVoice(vm: StudioViewModel, location: RunLocation, model: PhoneModel?, asr: PhoneModel?, done: ()->Unit) {
    val state by vm.state.collectAsState()
    val phone by vm.phone.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current
    var name by rememberSaveable { mutableStateOf("") }
    var sample by rememberSaveable { mutableStateOf<String?>(null) }
    var consent by rememberSaveable { mutableStateOf(false) }
    var recording by remember { mutableStateOf(false) }
    var seconds by remember { mutableIntStateOf(0) }
    var saving by remember { mutableStateOf(false) }
    val recorder = remember { SampleRecorder(context) }
    val cloneReady = model?.let { it.capability == "clone" && phone.canRun(it, vm.phone.ramBytes) } == true && asr?.let { phone.canRun(it, vm.phone.ramBytes) } == true
    LaunchedEffect(Unit) { sample?.let { if(!File(it).exists()) sample = null } }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if(event == Lifecycle.Event.ON_STOP && recording) { recorder.discard(); recording = false; sample = null } }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer); if(recording) recorder.discard(); if(!saving) sample?.let { File(it).delete() } }
    }
    LaunchedEffect(recording) {
        seconds = 0
        while(recording) {
            delay(1000); seconds++
            if(seconds >= EASY_MAX_SAMPLE_SECONDS) { try { sample = recorder.stop().absolutePath } catch(e: Exception) { sample = null; vm.fail(e) } finally { recording = false } }
        }
    }
    val record = permissionAction(Manifest.permission.RECORD_AUDIO, "mobile.permissions.microphone", vm::fail) {
        try { sample?.let { File(it).delete() }; sample = recorder.start().absolutePath; recording = true } catch(e: Exception) { vm.fail(e) }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if(uri != null) scope.launch { try { sample?.let { File(it).delete() }; sample = copyMedia(context, uri, "audio").absolutePath } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) } }
    }
    val busy = phone.progress != null || state.busy
    EasyPage {
        Text(tr("easy.wizard_title"), fontSize = 24.sp, fontWeight = FontWeight.Bold)
        EasyStepTitle(1, tr("easy.name_question"))
        OutlinedTextField(name, { name = it.take(200) }, modifier = Modifier.fillMaxWidth().testTag("easy.voice_name"), singleLine = true,
            placeholder = { Text(tr("easy.name_placeholder")) }, shape = RoundedCornerShape(16.dp), textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 18.sp),
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = EasyBrandStart, unfocusedBorderColor = role("border"), focusedContainerColor = role("surface"), unfocusedContainerColor = role("surface")))
        Text(tr("easy.name_hint"), fontSize = 14.sp, color = role("textMuted"))

        EasyStepTitle(2, tr("easy.audio_question"))
        Text(tr("easy.audio_hint"), fontSize = 15.sp, lineHeight = 22.sp, color = role("textMuted"))
        EasyCardSurface {
            Text(tr("easy.read_this"), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = easyAccent())
            Text(tr("easy.example_sentence"), fontSize = 20.sp, lineHeight = 30.sp, fontWeight = FontWeight.Medium)
            if(recording) {
                Text(tr("easy.recording_now") + "  " + tr("easy.audio_length", mapOf("seconds" to seconds)), fontSize = 15.sp, color = role("errorForeground"))
                if(seconds >= 3) Text(tr("easy.recording_enough"), fontSize = 14.sp, color = role("textMuted"))
                EasyPrimaryButton(tr("easy.stop_recording"), VSIcons.Stop) {
                    try { sample = recorder.stop().absolutePath; recording = false } catch(e: Exception) { recording = false; sample = null; vm.fail(e) }
                }
            } else {
                Text(tr("easy.recording_tip"), fontSize = 14.sp, color = role("textMuted"))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    EasyButton(tr(if(sample == null) "easy.start_recording" else "easy.record_again"), VSIcons.Mic, enabled = !busy, modifier = Modifier.weight(1f), onClick = record)
                    EasyButton(tr(if(sample == null) "easy.pick_file" else "easy.pick_again"), VSIcons.Folder, enabled = !busy, modifier = Modifier.weight(1f)) { pick.launch(arrayOf("audio/*")) }
                }
            }
        }
        val ready = sample?.takeIf { !recording }?.let(::File)
        if(ready != null && ready.exists()) {
            Text(tr("easy.audio_ready"), fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = easyAccent())
            LocalAudioPlayer(ready, vm::fail)
        }

        EasyStepTitle(3, tr("easy.save_question"))
        Surface(onClick = { consent = !consent }, shape = RoundedCornerShape(16.dp), color = role("surface"), border = BorderStroke(VSTheme.borderWidth, role("border")), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Checkbox(consent, { consent = it }, colors = CheckboxDefaults.colors(checkedColor = EasyBrandStart))
                Text(tr("easy.consent"), fontSize = 16.sp, lineHeight = 23.sp, modifier = Modifier.weight(1f))
            }
        }
        if(location != RunLocation.COMPUTER && !cloneReady) {
            EasyNote(tr("easy.setup_needed_title") + "\n" + tr("mobile.easy.download_body"))
            MissingModelsCard(vm, "easy.voices_title", listOfNotNull(model, asr))
        }
        phone.progress?.let { p ->
            Text(tr("easy.getting_ready"), fontSize = 16.sp)
            LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth(), color = EasyBrandStart)
        }
        if(state.busy && location == RunLocation.COMPUTER) LinearProgressIndicator(Modifier.fillMaxWidth(), color = EasyBrandStart)
        EasyPrimaryButton(tr("easy.save_voice"), Icons.Default.Check,
            enabled = consent && ready != null && name.isNotBlank() && !recording && !busy && (location == RunLocation.COMPUTER || cloneReady)) {
            val file = File(sample!!)
            saving = true
            if(location == RunLocation.COMPUTER) { vm.clone(name.trim(), file); sample = null; done() }
            else vm.phone.clone(name.trim(), file, asr!!, model!!, consent) { saving = false; sample = null; done() }
        }
        EasyButton(tr("easy.cancel"), Icons.Default.Close, enabled = !recording, modifier = Modifier.fillMaxWidth()) {
            vm.phone.cancelInference(); saving = false; sample?.let { File(it).delete() }; sample = null; done()
        }
    }
}

// ---------------------------------------------------------------- Made speech

private data class Take(val id: String, val text: String, val phone: com.voicestudio.mobile.features.PhoneGeneration? = null, val host: HistoryItem? = null)

@Composable fun EasyHistoryScreen(vm: StudioViewModel) {
    val phone by vm.phone.state.collectAsState()
    val state by vm.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val saveFile = rememberSaveFile(vm)
    var playing by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<Take?>(null) }
    LaunchedEffect(Unit) { try { vm.phone.refresh() } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) } }
    val takes = phone.recent.map { Take("phone:" + it.id, it.text, phone = it) } + state.history.map { Take("host:" + it.id, it.text, host = it) }
    val format = remember { java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT) }
    fun hostPath(take: Take) = vm.api?.audioPath(take.host!!.audioPath)
    EasyPage {
        if(takes.isEmpty()) EasyEmpty(EasyIcons.Speaker, tr("easy.no_history_title"), tr("easy.no_history_body"))
        takes.forEach { take ->
            EasyCardSurface(modifier = Modifier.testTag("easy.take.${take.id}")) {
                Text(take.text, fontSize = 18.sp, lineHeight = 26.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull(take.phone?.createdAt?.let { format.format(java.util.Date(it)) },
                    tr(if(take.phone != null) "mobile.local.this_phone" else "mobile.local.my_computer")).joinToString(" · "), fontSize = 14.sp, color = role("textMuted"))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val isPlaying = playing == take.id
                    EasyButton(tr(if(isPlaying) "easy.stop" else "easy.play"), if(isPlaying) VSIcons.Stop else Icons.Default.PlayArrow) { playing = if(isPlaying) null else take.id }
                    EasyButton(tr("easy.save_short"), VSIcons.Download) {
                        val generation = take.phone
                        if(generation != null) saveFile(vm.phone.generationFile(generation), fileName(take.text))
                        else vm.api?.let { api -> scope.launch { try { saveFile(sharedDownload(context, api, hostPath(take)!!, "wav"), fileName(take.text)) } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) } } }
                    }
                    EasyButton(tr("mobile.speak.share"), Icons.Default.Share) {
                        val generation = take.phone
                        if(generation != null) scope.launch { try { shareLocalFile(context, vm.phone.generationFile(generation), "audio/wav") } catch(e: CancellationException) { throw e } catch(e: Exception) { vm.fail(e) } }
                        else vm.api?.let { api -> vm.run { shareFile(context, sharedDownload(context, api, hostPath(take)!!, "wav"), "audio/wav") } }
                    }
                    EasyButton(tr("easy.delete"), Icons.Default.Delete, danger = true, enabled = !state.busy) { deleting = take }
                }
                if(playing == take.id) {
                    val generation = take.phone
                    if(generation != null) LocalAudioPlayer(vm.phone.generationFile(generation), vm::fail)
                    else vm.api?.let { api -> hostPath(take)?.let { HostPlayer(api, it, vm::fail) } }
                }
            }
        }
    }
    deleting?.let { take ->
        AlertDialog(shape = EasyCardShape, onDismissRequest = { deleting = null }, title = { Text(tr("easy.delete_take_title")) }, text = { Text(tr("easy.delete_take_body")) },
            confirmButton = { TextButton(onClick = {
                take.phone?.let { vm.phone.deleteGeneration(it) }; take.host?.let { vm.deleteHistory(it) }
                if(playing == take.id) playing = null; deleting = null
            }) { Text(tr("easy.delete"), color = role("errorForeground")) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text(tr("easy.cancel")) } })
    }
}
