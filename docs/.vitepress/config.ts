import { defineConfig } from "vitepress";

export default defineConfig({
  title: "deer",
  description:
    "Unattended coding agent — run multiple Claude Code instances safely in parallel.",

  base: "/deer/",

  head: [["link", { rel: "icon", href: "/deer/favicon.ico" }]],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started/" },
      { text: "Configuration", link: "/configuration/" },
      { text: "GitHub", link: "https://github.com/zdavison/deer" },
    ],

    sidebar: [
      {
        text: "Getting Started",
        collapsed: false,
        items: [
          { text: "Overview", link: "/getting-started/" },
          { text: "Installation", link: "/getting-started/installation" },
          {
            text: "Your First Agent (deer)",
            link: "/getting-started/first-agent-deer",
          },
          {
            text: "Your First Agent (deerbox)",
            link: "/getting-started/first-agent-deerbox",
          },
        ],
      },
      {
        text: "deer",
        collapsed: false,
        items: [
          { text: "Overview", link: "/deer/" },
          { text: "Dashboard", link: "/deer/dashboard" },
          { text: "Agent Lifecycle", link: "/deer/agent-lifecycle" },
          { text: "Creating PRs", link: "/deer/creating-prs" },
          { text: "Context System", link: "/deer/context-system" },
          { text: "Multi-Instance", link: "/deer/multi-instance" },
        ],
      },
      {
        text: "deerbox",
        collapsed: false,
        items: [
          { text: "Overview", link: "/deerbox/" },
          { text: "CLI Reference", link: "/deerbox/cli-reference" },
          { text: "Session Flow", link: "/deerbox/session-flow" },
          { text: "Ecosystems", link: "/deerbox/ecosystems" },
          { text: "Worktrees", link: "/deerbox/worktrees" },
        ],
      },
      {
        text: "Configuration",
        collapsed: false,
        items: [
          { text: "Overview", link: "/configuration/" },
          { text: "Config Files", link: "/configuration/config-files" },
          { text: "Field Reference", link: "/configuration/field-reference" },
          {
            text: "deer.toml Examples",
            link: "/configuration/examples",
          },
        ],
      },
      {
        text: "Security",
        collapsed: false,
        items: [
          { text: "Overview", link: "/security/" },
          { text: "Sandboxing", link: "/security/sandboxing" },
          {
            text: "Network & Auth Proxy",
            link: "/security/network",
          },
          {
            text: "Environment Variables",
            link: "/security/environment",
          },
        ],
      },
      {
        text: "Architecture",
        collapsed: false,
        items: [
          { text: "Overview", link: "/architecture/" },
          {
            text: "How deer Uses deerbox",
            link: "/architecture/deer-and-deerbox",
          },
          { text: "Data Layout", link: "/architecture/data-layout" },
        ],
      },
      {
        text: "Reference",
        collapsed: false,
        items: [
          { text: "Authentication", link: "/authentication" },
          { text: "Language & i18n", link: "/i18n" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
    ],

    search: {
      provider: "local",
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/zdavison/deer" },
    ],

    editLink: {
      pattern: "https://github.com/zdavison/deer/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2024-present deer contributors",
    },
  },
});
