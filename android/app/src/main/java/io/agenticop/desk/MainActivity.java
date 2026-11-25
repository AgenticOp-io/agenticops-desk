package io.agenticop.desk;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // DeskWatchWorker stays quiet while the app is on screen; the app shows the same prompts itself.
    static volatile boolean visible;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeskWatchPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        super.onPause();
    }
}
