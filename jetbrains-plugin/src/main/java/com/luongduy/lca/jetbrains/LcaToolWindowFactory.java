package com.luongduy.lca.jetbrains;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import org.jetbrains.annotations.NotNull;

import javax.swing.BorderFactory;
import javax.swing.JLabel;
import javax.swing.JPanel;
import java.awt.BorderLayout;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

public final class LcaToolWindowFactory implements ToolWindowFactory, DumbAware {
    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        JPanel panel = new JPanel(new BorderLayout());
        JLabel status = new JLabel("Starting Local Coding Agent Control Center…");
        status.setBorder(BorderFactory.createEmptyBorder(12, 12, 12, 12));
        panel.add(status, BorderLayout.NORTH);

        Content content = ContentFactory.getInstance().createContent(panel, "", false);
        toolWindow.getContentManager().addContent(content);

        if (!JBCefApp.isSupported()) {
            status.setText("This IDE runtime does not provide JCEF. Use `lca ui` in a terminal.");
            return;
        }

        CompletableFuture
            .supplyAsync(() -> launchUrl(project))
            .whenComplete((url, error) -> ApplicationManager.getApplication().invokeLater(() -> {
                if (error != null || url == null || url.isBlank()) {
                    status.setText(errorMessage(error));
                    return;
                }
                JBCefBrowser browser = new JBCefBrowser(url);
                panel.removeAll();
                panel.add(browser.getComponent(), BorderLayout.CENTER);
                panel.revalidate();
                panel.repaint();
                content.setDisposer(browser);
            }));
    }

    private static String launchUrl(Project project) {
        String executable = System.getProperty("lca.cli.path", "lca");
        List<String> command = new ArrayList<>();
        command.add(executable);
        command.add("ui");
        command.add("--print-url");
        command.add("--no-open");
        command.add("--host");
        command.add("jetbrains");
        if (project.getBasePath() != null) {
            command.add("--workspace");
            command.add(project.getBasePath());
        }

        try {
            Process process = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .start();
            boolean exited = process.waitFor(30, TimeUnit.SECONDS);
            if (!exited) {
                process.destroyForcibly();
                throw new IllegalStateException("`lca ui` did not return a launch URL within 30 seconds.");
            }
            String output;
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                output = reader.lines().collect(Collectors.joining("\n"));
            }
            if (process.exitValue() != 0) {
                throw new IllegalStateException(output.isBlank() ? "`lca ui` failed." : output.trim());
            }
            return output.lines()
                .map(String::trim)
                .filter(line -> line.startsWith("http://127.0.0.1:") || line.startsWith("http://localhost:"))
                .reduce((first, second) -> second)
                .orElseThrow(() -> new IllegalStateException("`lca ui` did not return a local launch URL."));
        } catch (Exception error) {
            throw new IllegalStateException(error.getMessage(), error);
        }
    }

    private static String errorMessage(Throwable error) {
        Throwable cause = error;
        while (cause != null && cause.getCause() != null) cause = cause.getCause();
        String message = cause == null ? null : cause.getMessage();
        return "Could not open Local Coding Agent: " +
            (message == null || message.isBlank() ? "run `lca ui` in a terminal." : message);
    }
}
