package com.unifiedexpenseos.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.unifiedexpenseos.app.localllm.LocalLlmPlugin;
import com.unifiedexpenseos.app.smsreader.SmsReaderPlugin;
import com.unifiedexpenseos.app.voiceinput.VoiceInputPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the custom plugins before the bridge initializes.
        registerPlugin(SmsReaderPlugin.class);
        registerPlugin(VoiceInputPlugin.class);
        registerPlugin(LocalLlmPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
