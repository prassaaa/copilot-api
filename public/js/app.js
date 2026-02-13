/**
 * Copilot API Console - Alpine.js Application
 */

document.addEventListener("alpine:init", () => {
  Alpine.data("app", () => ({
    // State
    activeTab: "dashboard",
    loading: false,

    // Authentication
    auth: {
      authenticated: false,
      passwordRequired: false,
      password: "",
      checking: true,
    },

    // Toast
    toast: {
      show: false,
      message: "",
      type: "info",
    },

    // Server status
    status: {
      connected: false,
      version: null,
      uptime: 0,
      user: null,
      accountType: null,
      modelsCount: 0,
    },

    // Models
    models: [],
    modelFilter: 'all',
    modelSearch: '',

    // Usage stats
    usageStats: {
      totalRequests: 0,
      byModel: {},
      byHour: [],
    },

    // Copilot usage/quota
    copilotUsage: {
      access_type_sku: null,
      copilot_plan: null,
      quota_reset_date: null,
      chat_enabled: null,
      assigned_date: null,
      quota_snapshots: null,
    },

    // Logs
    logs: [],
    logsAutoScroll: true,
    logsEventSource: null,
    logsFilter: "all", // all, info, warn, error, debug, success
    logsErrorsOnly: false,
    logsSearch: "",
    logsPaused: false,
    logsConnected: false,
    notificationsEventSource: null,

    // Settings
    settings: {
      port: 4141,
      debug: false,
      trackUsage: true,
      fallbackEnabled: false,
      rateLimitSeconds: null,
      rateLimitWait: false,
      modelMapping: {},
      defaultModel: "gpt-4.1",
      defaultSmallModel: "gpt-4.1",
      webuiPasswordSet: false,
      poolEnabled: false,
      poolStrategy: "sticky",
      configPath: "",
    },

    // Server info
    serverInfo: {
      version: null,
      uptime: 0,
      user: null,
      configPath: "",
      claudeConfigPath: "",
    },

    // New password field
    newWebuiPassword: "",
    showPassword: false,

    // Settings change tracking
    originalSettings: null,
    hasUnsavedChanges: false,

    // Model mapping editor
    newMappingFrom: "",
    newMappingTo: "",
    modelSuggestions: [],
    showModelSuggestions: false,

    // Logs date filter
    logsDateFrom: "",
    logsDateTo: "",

    // Claude CLI preview
    showClaudePreview: false,
    claudePreviewConfig: null,

    // Notifications
    notifications: [],
    notificationSettings: {
      rateLimitAlerts: true,
      accountErrorAlerts: true,
      soundEnabled: false,
    },
    versionCheck: {
      checking: true,
      blocked: false,
      local: null,
      remote: null,
      message: "",
      updateCommand: "",
    },

    // Rate limit validation
    rateLimitError: "",

    // Account pool
    accountPool: {
      enabled: false,
      strategy: "sticky",
      accounts: [],
      currentAccountId: null,
      configuredCount: 0,
    },
    newAccountLabel: "",
    accountPoolQuotaFilter: "all",

    // OAuth flow state
    oauthFlow: {
      active: false,
      flowId: null,
      userCode: "",
      verificationUri: "",
      expiresIn: 0,
      completing: false,
    },

    // Chart instance
    usageChart: null,
    chartType: "bar", // 'bar' or 'doughnut'

    // Request history
    requestHistoryEntries: [],
    historyStats: {},
    historyFilter: {
      model: "",
      status: "",
      accountId: "",
    },
    historyOffset: 0,
    historyTotal: 0,
    historyHasMore: false,
    autoRefreshInterval: null,
    versionCheckInterval: null,

    // API Playground
    playground: {
      endpoint: "/v1/chat/completions",
      model: "gpt-4.1",
      request: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      }, null, 2),
      response: "",
      loading: false,
      stream: false,
      error: null,
      duration: 0,
      statusCode: null,
      statusText: "",
    },

    // Initialize
    async init() {
      // Watch for chart type changes
      this.$watch('chartType', () => {
        this.updateChart()
      })
      
      await this.checkAuth()

      if (this.auth.authenticated || !this.auth.passwordRequired) {
        await this.fetchData()
        await this.loadRecentLogs()
        this.connectLogStream()
        this.connectNotificationStream()
        await this.checkVersion()
        this.startVersionCheckPolling()

        // Auto-refresh every 30 seconds
        this.autoRefreshInterval = setInterval(() => {
          if (
            !this.loading
            && (this.auth.authenticated || !this.auth.passwordRequired)
          ) {
            this.fetchStatus()
            this.fetchUsageStats()
            this.fetchCopilotUsage()
          }
        }, 30000)
      }
    },
    async checkVersion() {
      this.versionCheck.checking = true
      try {
        const { data } = await this.requestJson("/api/version-check")
        if (data.status === "ok" && data.local && data.remote) {
          const upToDate = data.local === data.remote
          this.versionCheck = {
            checking: false,
            blocked: !upToDate,
            local: data.local || null,
            remote: data.remote || null,
            message: data.message || "",
            updateCommand: data.updateCommand || "",
          }
          if (!upToDate) {
            this.versionCheck.message =
              data.message || "Dashboard is outdated."
          }
        } else if (data.status === "outdated") {
          this.versionCheck = {
            checking: false,
            blocked: true,
            local: data.local || null,
            remote: data.remote || null,
            message: data.message || "Dashboard is outdated.",
            updateCommand: data.updateCommand || "git pull origin main",
          }
        } else {
          this.versionCheck = {
            ...this.versionCheck,
            checking: false,
            message: data.message || "Version check failed.",
          }
        }
      } catch (error) {
        this.versionCheck = {
          ...this.versionCheck,
          checking: false,
          message: error.message || "Version check failed.",
        }
      }
    },
    async requestJson(url, options) {
      const response = await fetch(url, options)
      if (response.status === 401) {
        this.handleAuthExpired()
        throw new Error("Authentication required")
      }
      const data = await response.json()
      return { response, data }
    },
    handleAuthExpired() {
      this.auth.authenticated = false
      this.auth.passwordRequired = true
      this.auth.password = ""
      if (this.logsEventSource) {
        this.logsEventSource.close()
        this.logsEventSource = null
      }
      if (this.notificationsEventSource) {
        this.notificationsEventSource.close()
        this.notificationsEventSource = null
      }
      if (this.autoRefreshInterval) {
        clearInterval(this.autoRefreshInterval)
        this.autoRefreshInterval = null
      }
      if (this.versionCheckInterval) {
        clearInterval(this.versionCheckInterval)
        this.versionCheckInterval = null
      }
      this.showToast("Session expired. Please login again.", "warning")
    },

    // Check authentication status
    async checkAuth() {
      this.auth.checking = true
      try {
        const { data } = await this.requestJson("/api/auth-status")
        this.auth.authenticated = data.authenticated
        this.auth.passwordRequired = data.passwordRequired
      } catch (error) {
        console.error("Auth check failed:", error)
        this.auth.authenticated = false
        this.auth.passwordRequired = true
      } finally {
        this.auth.checking = false
      }
    },

    // Login
    async login() {
      this.loading = true
      try {
        const response = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: this.auth.password }),
        })
        const data = await response.json()

        if (response.status === 401 || data.status === "error") {
          this.showToast(data.error || "Invalid password", "error")
          return
        }

        if (data.status === "ok") {
          this.auth.authenticated = true
          this.auth.password = ""
          this.showToast("Login successful", "success")
          await this.fetchData()
          this.connectLogStream()
          this.connectNotificationStream()
          await this.checkVersion()
          this.startVersionCheckPolling()
        }
      } catch {
        this.showToast("Login failed. Please try again.", "error")
      } finally {
        this.loading = false
      }
    },

    // Logout
    async logout() {
      try {
        await this.requestJson("/api/logout", { method: "POST" })
        this.auth.authenticated = false
        if (this.logsEventSource) {
          this.logsEventSource.close()
          this.logsEventSource = null
        }
        if (this.notificationsEventSource) {
          this.notificationsEventSource.close()
          this.notificationsEventSource = null
        }
        if (this.autoRefreshInterval) {
          clearInterval(this.autoRefreshInterval)
          this.autoRefreshInterval = null
        }
        if (this.versionCheckInterval) {
          clearInterval(this.versionCheckInterval)
          this.versionCheckInterval = null
        }
        this.showToast("Logged out", "info")
      } catch (error) {
        console.error("Logout failed:", error)
      }
    },

    startVersionCheckPolling() {
      if (this.versionCheckInterval) {
        clearInterval(this.versionCheckInterval)
      }
      this.versionCheckInterval = setInterval(() => {
        if (this.auth.authenticated || !this.auth.passwordRequired) {
          this.checkVersion()
        }
      }, 120000)
    },

    // Fetch all data
    async fetchData() {
      this.loading = true
      try {
        await Promise.all([
          this.fetchStatus(),
          this.fetchModels(),
          this.fetchUsageStats(),
          this.fetchCopilotUsage(),
          this.fetchConfig(),
          this.fetchAccounts(),
        ])
        this.status.connected = true
      } catch (error) {
        console.error("Failed to fetch data:", error)
        this.status.connected = false
        this.showToast("Failed to connect to server", "error")
      } finally {
        this.loading = false
      }
    },

    // Restart server
    async restartServer() {
      if (!confirm("Are you sure you want to restart the server? This will temporarily interrupt service.")) {
        return
      }

      try {
        const response = await fetch("/api/server/restart", {
          method: "POST",
        })
        const data = await response.json()
        if (data.status === "ok") {
          this.showToast("Server is restarting...", "warning")
          this.status.connected = false

          // Try to reconnect after a delay
          setTimeout(async () => {
            let retries = 0
            const maxRetries = 30
            const checkConnection = async () => {
              try {
                const resp = await fetch("/api/status")
                if (resp.ok) {
                  this.showToast("Server restarted successfully!", "success")
                  this.status.connected = true
                  await this.fetchData()
                  return true
                }
              } catch {
                // Server not ready yet
              }
              retries++
              if (retries < maxRetries) {
                setTimeout(checkConnection, 2000)
              } else {
                this.showToast("Server restart taking longer than expected. Please refresh the page.", "error")
              }
              return false
            }
            checkConnection()
          }, 2000)
        }
      } catch (error) {
        this.showToast("Failed to restart server: " + error.message, "error")
      }
    },

    // Fetch server status
    async fetchStatus() {
      try {
        const { data } = await this.requestJson("/api/status")
        if (data.status === "ok") {
          this.status = {
            ...this.status,
            connected: true,
            version: data.version,
            uptime: data.uptime,
            user: data.user,
            accountType: data.accountType,
            modelsCount: data.modelsCount,
          }
          // Also update serverInfo from status
          this.serverInfo.version = data.version || this.serverInfo.version
          this.serverInfo.uptime = data.uptime || this.serverInfo.uptime
          this.serverInfo.user = data.user
          this.serverInfo.configPath = data.configPath || this.serverInfo.configPath
          this.serverInfo.claudeConfigPath = data.claudeConfigPath || this.serverInfo.claudeConfigPath
        }
      } catch {
        this.status.connected = false
      }
    },

    // Fetch models
    async fetchModels() {
      try {
        const { data } = await this.requestJson("/api/models")
        if (data.status === "ok") {
          this.models = data.models

          // Set default model if not set
          if (this.models.length > 0 && !this.settings.defaultModel) {
            this.settings.defaultModel = this.models[0].id
            this.settings.defaultSmallModel = this.models[0].id
          }

          // Sync playground model with available models
          if (this.models.length > 0) {
            const modelExists = this.models.some(m => m.id === this.playground.model)
            if (!modelExists) {
              this.playground.model = this.models[0].id
              this.updatePlaygroundRequest()
            }
          }
        }
      } catch (error) {
        console.error("Failed to fetch models:", error)
      }
    },

    // Fetch usage statistics
    async fetchUsageStats() {
      try {
        const { data } = await this.requestJson("/api/usage-stats?period=24h")
        if (data.status === "ok") {
          this.usageStats = data.stats
          this.updateChart()
        }
      } catch (error) {
        console.error("Failed to fetch usage stats:", error)
      }
    },

    // Fetch Copilot usage/quota
    async fetchCopilotUsage() {
      try {
        const { data } = await this.requestJson("/api/copilot-usage")
        if (data.status === "ok" && data.usage) {
          this.copilotUsage = {
            access_type_sku: data.usage.access_type_sku,
            copilot_plan: data.usage.copilot_plan,
            quota_reset_date: data.usage.quota_reset_date,
            chat_enabled: data.usage.chat_enabled,
            assigned_date: data.usage.assigned_date,
            quota_snapshots: data.usage.quota_snapshots || null,
          }
        }
      } catch (error) {
        console.error("Failed to fetch Copilot usage:", error)
      }
    },

    // Fetch configuration
    async fetchConfig() {
      try {
        const { data } = await this.requestJson("/api/config")
        if (data.status === "ok") {
          this.settings = { ...this.settings, ...data.config }
          if (data.serverInfo) {
            this.serverInfo = { ...this.serverInfo, ...data.serverInfo }
          }
          // Store original settings for change detection
          this.originalSettings = JSON.stringify({
            debug: this.settings.debug,
            trackUsage: this.settings.trackUsage,
            fallbackEnabled: this.settings.fallbackEnabled,
            rateLimitSeconds: this.settings.rateLimitSeconds,
            rateLimitWait: this.settings.rateLimitWait,
            modelMapping: this.settings.modelMapping,
            defaultModel: this.settings.defaultModel,
            defaultSmallModel: this.settings.defaultSmallModel,
          })
          this.hasUnsavedChanges = false
        }
      } catch (error) {
        console.error("Failed to fetch config:", error)
      }
    },

    // Fetch accounts
    async fetchAccounts() {
      try {
        const { data } = await this.requestJson("/api/accounts")
        if (data.status === "ok") {
          this.accountPool = {
            enabled: data.poolEnabled ?? false,
            strategy: data.strategy ?? "sticky",
            accounts: data.accounts ?? [],
            currentAccountId: data.currentAccountId ?? null,
            configuredCount: data.configuredCount ?? data.accounts?.length ?? 0,
          }
        }
      } catch (error) {
        console.error("Failed to fetch accounts:", error)
        // Ensure accountPool has valid defaults on error
        if (!this.accountPool || !this.accountPool.accounts) {
          this.accountPool = {
            enabled: false,
            strategy: "sticky",
            accounts: [],
            currentAccountId: null,
            configuredCount: 0,
          }
        }
      }
    },

    // Start OAuth flow for adding account
    async startOAuthFlow() {
      try {
        const { data } = await this.requestJson("/api/accounts/oauth/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: this.newAccountLabel || undefined,
          }),
        })
        if (data.status === "ok") {
          this.oauthFlow = {
            active: true,
            flowId: data.flowId,
            userCode: data.userCode,
            verificationUri: data.verificationUri,
            expiresIn: data.expiresIn,
            completing: false,
          }
          this.showToast("Enter the code on GitHub to authorize", "info")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to start OAuth: " + error.message, "error")
      }
    },

    // Complete OAuth flow
    async completeOAuthFlow() {
      this.oauthFlow.completing = true
      try {
        const { data } = await this.requestJson("/api/accounts/oauth/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            flowId: this.oauthFlow.flowId,
          }),
        })
        if (data.status === "ok") {
          this.resetOAuthFlow()
          this.newAccountLabel = ""
          await this.fetchAccounts()
          this.showToast(`Account ${data.account.login} added successfully!`, "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.oauthFlow.completing = false
        this.showToast("Failed to complete OAuth: " + error.message, "error")
      }
    },

    // Cancel OAuth flow
    async cancelOAuthFlow() {
      try {
        await this.requestJson("/api/accounts/oauth/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId: this.oauthFlow.flowId }),
        })
      } catch {
        // Ignore errors
      }
      this.resetOAuthFlow()
    },

    // Reset OAuth flow state
    resetOAuthFlow() {
      this.oauthFlow = {
        active: false,
        flowId: null,
        userCode: "",
        verificationUri: "",
        expiresIn: 0,
        completing: false,
      }
    },

    // Remove account from pool
    async removeAccount(id) {
      if (!confirm(`Remove account ${id}?`)) return

      try {
        const { data } = await this.requestJson(`/api/accounts/${id}`, {
          method: "DELETE",
        })
        if (data.status === "ok") {
          await this.fetchAccounts()
          this.showToast(`Account ${id} removed`, "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to remove account: " + error.message, "error")
      }
    },

    // Toggle account pause state
    async togglePauseAccount(id, paused) {
      try {
        const { data } = await this.requestJson(`/api/accounts/${id}/pause`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paused }),
        })
        if (data.status === "ok") {
          await this.fetchAccounts()
          this.showToast(`Account ${id} ${paused ? "paused" : "resumed"}`, "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to toggle account: " + error.message, "error")
      }
    },

    // Set account as current (sticky)
    async setCurrentAccount(id) {
      try {
        const { data } = await this.requestJson(`/api/accounts/${id}/set-current`, {
          method: "POST",
        })
        if (data.status === "ok") {
          this.accountPool.accounts = data.accounts
          this.accountPool.currentAccountId = data.currentAccountId
          // Refresh status to update user display
          await this.fetchStatus()
          this.showToast(`Account ${id} set as current`, "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to set current account: " + error.message, "error")
      }
    },

    // Refresh all account tokens
    async refreshAccounts() {
      try {
        const { data } = await this.requestJson("/api/accounts/refresh", {
          method: "POST",
        })
        if (data.status === "ok") {
          this.accountPool.accounts = data.accounts
          this.accountPool.currentAccountId = data.currentAccountId
          this.showToast(data.message || "Token refresh started", "success")

          // Refresh the list again after background refresh has time to complete
          setTimeout(() => {
            void this.fetchAccounts()
          }, 4000)
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to refresh tokens: " + error.message, "error")
      }
    },

    // Refresh all account quotas
    async refreshQuotas() {
      try {
        const { data } = await this.requestJson("/api/accounts/refresh-quotas", {
          method: "POST",
        })
        if (data.status === "ok") {
          this.accountPool.accounts = data.accounts
          this.showToast("Quotas refreshed for all accounts", "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to refresh quotas: " + error.message, "error")
      }
    },

    // Fetch accounts quota (for Usage tab)
    async fetchAccountsQuota() {
      try {
        // First refresh quotas
        const { data } = await this.requestJson("/api/accounts/refresh-quotas", {
          method: "POST",
        })
        if (data.status === "ok") {
          this.accountPool.accounts = data.accounts
        }
      } catch (error) {
        console.error("Failed to fetch accounts quota:", error)
      }
    },

    // Update pool configuration
    async updatePoolConfig() {
      try {
        const { data } = await this.requestJson("/api/pool-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: this.accountPool.enabled,
            strategy: this.accountPool.strategy,
          }),
        })
        if (data.status === "ok") {
          this.showToast("Pool configuration updated", "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to update pool config: " + error.message, "error")
      }
    },

    // Save settings
    async saveSettings() {
      try {
        const { data } = await this.requestJson("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debug: this.settings.debug,
            trackUsage: this.settings.trackUsage,
            fallbackEnabled: this.settings.fallbackEnabled,
            rateLimitSeconds: this.settings.rateLimitSeconds || undefined,
            rateLimitWait: this.settings.rateLimitWait,
            modelMapping: this.settings.modelMapping,
            defaultModel: this.settings.defaultModel,
            defaultSmallModel: this.settings.defaultSmallModel,
          }),
        })
        if (data.status === "ok") {
          this.showToast("Settings saved successfully", "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to save settings: " + error.message, "error")
      }
    },

    // Add model mapping
    addModelMapping() {
      if (!this.newMappingFrom || !this.newMappingTo) {
        this.showToast("Please enter both source and target model", "error")
        return
      }
      this.settings.modelMapping = {
        ...this.settings.modelMapping,
        [this.newMappingFrom]: this.newMappingTo,
      }
      this.newMappingFrom = ""
      this.newMappingTo = ""
      this.showModelSuggestions = false
      this.showToast("Model mapping added (save to apply)", "info")
    },

    // Filter model suggestions for autocomplete
    filterModelSuggestions() {
      const query = this.newMappingFrom.toLowerCase().trim()
      if (!query) {
        this.modelSuggestions = this.models.map((m) => m.id).slice(0, 10)
        return
      }
      // Common model name patterns to suggest
      const commonPatterns = [
        "claude-3-opus", "claude-3-sonnet", "claude-3-haiku",
        "claude-3.5-sonnet", "claude-3.5-haiku",
        "gpt-4", "gpt-4-turbo", "gpt-4o", "gpt-4o-mini",
        "gpt-3.5-turbo", "o1-preview", "o1-mini",
        "gemini-pro", "gemini-1.5-pro", "gemini-1.5-flash",
      ]
      // Combine with actual models
      const allModels = [...new Set([...commonPatterns, ...this.models.map((m) => m.id)])]
      this.modelSuggestions = allModels
        .filter((m) => m.toLowerCase().includes(query))
        .slice(0, 10)
    },

    // Select model suggestion
    selectModelSuggestion(model) {
      this.newMappingFrom = model
      this.showModelSuggestions = false
    },

    // Remove model mapping
    removeModelMapping(from) {
      const { [from]: _, ...rest } = this.settings.modelMapping
      this.settings.modelMapping = rest
      this.showToast("Model mapping removed (save to apply)", "info")
    },

    // Validate rate limit input
    validateRateLimit() {
      const value = this.settings.rateLimitSeconds
      if (value === null || value === "" || value === undefined) {
        this.rateLimitError = ""
        return true
      }
      if (value < 0) {
        this.rateLimitError = "Rate limit cannot be negative"
        return false
      }
      if (value > 3600) {
        this.rateLimitError = "Rate limit cannot exceed 3600 seconds (1 hour)"
        return false
      }
      if (!Number.isInteger(value)) {
        this.rateLimitError = "Rate limit must be a whole number"
        return false
      }
      this.rateLimitError = ""
      return true
    },

    // Check for unsaved changes
    checkUnsavedChanges() {
      if (!this.originalSettings) return false
      const currentSettings = JSON.stringify({
        debug: this.settings.debug,
        trackUsage: this.settings.trackUsage,
        fallbackEnabled: this.settings.fallbackEnabled,
        rateLimitSeconds: this.settings.rateLimitSeconds,
        rateLimitWait: this.settings.rateLimitWait,
        modelMapping: this.settings.modelMapping,
        defaultModel: this.settings.defaultModel,
        defaultSmallModel: this.settings.defaultSmallModel,
      })
      this.hasUnsavedChanges = currentSettings !== this.originalSettings
      return this.hasUnsavedChanges
    },

    // Reset settings to defaults
    async resetSettings() {
      if (!confirm("Are you sure you want to reset all settings to defaults?")) return
      try {
        const { data } = await this.requestJson("/api/config/reset", {
          method: "POST",
        })
        if (data.status === "ok") {
          await this.fetchConfig()
          this.showToast("Settings reset to defaults", "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to reset settings: " + error.message, "error")
      }
    },

    // Export settings as JSON file
    exportSettings() {
      const exportData = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        settings: {
          debug: this.settings.debug,
          trackUsage: this.settings.trackUsage,
          fallbackEnabled: this.settings.fallbackEnabled,
          rateLimitSeconds: this.settings.rateLimitSeconds,
          rateLimitWait: this.settings.rateLimitWait,
          modelMapping: this.settings.modelMapping,
          defaultModel: this.settings.defaultModel,
          defaultSmallModel: this.settings.defaultSmallModel,
        },
      }
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `copilot-api-settings-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      this.showToast("Settings exported successfully", "success")
    },

    // Import settings from JSON file
    async importSettings(event) {
      const file = event.target.files[0]
      if (!file) return

      try {
        const text = await file.text()
        const data = JSON.parse(text)

        if (!data.settings) {
          throw new Error("Invalid settings file format")
        }

        // Confirm import
        if (!confirm("This will overwrite your current settings. Continue?")) {
          event.target.value = ""
          return
        }

        // Apply imported settings
        const importedSettings = data.settings
        this.settings = {
          ...this.settings,
          debug: importedSettings.debug ?? this.settings.debug,
          trackUsage: importedSettings.trackUsage ?? this.settings.trackUsage,
          fallbackEnabled: importedSettings.fallbackEnabled ?? this.settings.fallbackEnabled,
          rateLimitSeconds: importedSettings.rateLimitSeconds ?? this.settings.rateLimitSeconds,
          rateLimitWait: importedSettings.rateLimitWait ?? this.settings.rateLimitWait,
          modelMapping: importedSettings.modelMapping ?? this.settings.modelMapping,
          defaultModel: importedSettings.defaultModel ?? this.settings.defaultModel,
          defaultSmallModel: importedSettings.defaultSmallModel ?? this.settings.defaultSmallModel,
        }

        // Save to server
        await this.saveSettings()
        this.showToast("Settings imported successfully", "success")
      } catch (error) {
        this.showToast("Failed to import settings: " + error.message, "error")
      }

      // Reset file input
      event.target.value = ""
    },

    // Update WebUI password
    async updateWebuiPassword() {
      try {
        const newPassword = this.newWebuiPassword
        const { data } = await this.requestJson("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ webuiPassword: newPassword }),
        })
        if (data.status === "ok") {
          this.newWebuiPassword = ""
          this.settings.webuiPasswordSet = Boolean(newPassword)

          // Re-check auth status after password change
          await this.checkAuth()

          if (newPassword) {
            this.showToast(
              "Password updated. You may need to re-login.",
              "success",
            )
          } else {
            this.showToast("Password removed. WebUI is now open.", "info")
          }
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast("Failed to update password: " + error.message, "error")
      }
    },

    // Preview Claude CLI config
    previewClaudeConfig() {
      this.claudePreviewConfig = {
        env: {
          ANTHROPIC_BASE_URL: globalThis.location.origin,
          ANTHROPIC_AUTH_TOKEN: "dummy",
          ANTHROPIC_MODEL: this.settings.defaultModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL: this.settings.defaultModel,
          ANTHROPIC_SMALL_FAST_MODEL: this.settings.defaultSmallModel,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: this.settings.defaultSmallModel,
          DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        permissions: {
          deny: ["WebSearch"],
        },
      }
      this.showClaudePreview = true
    },

    // Apply Claude CLI config
    async applyClaudeConfig() {
      try {
        const config = {
          env: {
            ANTHROPIC_BASE_URL: globalThis.location.origin,
            ANTHROPIC_AUTH_TOKEN: "dummy",
            ANTHROPIC_MODEL: this.settings.defaultModel,
            ANTHROPIC_DEFAULT_SONNET_MODEL: this.settings.defaultModel,
            ANTHROPIC_SMALL_FAST_MODEL: this.settings.defaultSmallModel,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: this.settings.defaultSmallModel,
            DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
          permissions: {
            deny: ["WebSearch"],
          },
        }

        const { data } = await this.requestJson("/api/claude-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        })
        if (data.status === "ok") {
          this.showToast("Claude CLI config updated!", "success")
        } else {
          throw new Error(data.error)
        }
      } catch (error) {
        this.showToast(
          "Failed to update Claude config: " + error.message,
          "error",
        )
      }
    },

    // Connect to log stream
    connectLogStream() {
      if (this.logsEventSource) {
        this.logsEventSource.close()
      }

      this.logsEventSource = new EventSource("/api/logs/stream")
      this.logsConnected = false

      this.logsEventSource.addEventListener("log", (event) => {
        // Skip if paused
        if (this.logsPaused) return

        const log = JSON.parse(event.data)
        this.logs.push(log)

        // Keep only last 500 logs
        if (this.logs.length > 500) {
          this.logs = this.logs.slice(-500)
        }

        // Auto-scroll
        if (this.logsAutoScroll && this.$refs.logsContainer) {
          this.$nextTick(() => {
            this.$refs.logsContainer.scrollTop =
              this.$refs.logsContainer.scrollHeight
          })
        }

        // Check for alerts in log message
        this.checkLogForAlerts(log)
      })

      this.logsEventSource.addEventListener("connected", () => {
        console.log("Log stream connected")
        this.logsConnected = true
      })

      this.logsEventSource.onerror = () => {
        console.error("Log stream error, reconnecting...")
        this.logsConnected = false
        setTimeout(() => this.connectLogStream(), 5000)
      }
    },
    connectNotificationStream() {
      if (this.notificationsEventSource) {
        this.notificationsEventSource.close()
      }

      this.notificationsEventSource = new EventSource(
        "/api/notifications/stream",
      )
      this.notificationsEventSource.addEventListener("notification", (event) => {
        try {
          const notif = JSON.parse(event.data)
          this.addNotification({
            type: notif.type || "info",
            title: notif.title || "Notification",
            message: notif.message || "",
          })
        } catch {
          // Ignore parse errors
        }
      })
      this.notificationsEventSource.onerror = () => {
        setTimeout(() => this.connectNotificationStream(), 5000)
      }
    },

    // Check log for alert conditions
    checkLogForAlerts(log) {
      if (!log) return

      const message = (log.message || "").toLowerCase()

      // Check for rate limit alerts
      if (this.notificationSettings.rateLimitAlerts) {
        if (message.includes("rate limit") || message.includes("ratelimit") || message.includes("429")) {
          this.addNotification({
            type: "warning",
            title: "Rate Limit Warning",
            message: log.message,
          })
        }
      }

      // Check for account error alerts
      if (this.notificationSettings.accountErrorAlerts) {
        if (message.includes("account") && (message.includes("error") || message.includes("failed") || message.includes("deactivat"))) {
          this.addNotification({
            type: "error",
            title: "Account Error",
            message: log.message,
          })
        }
      }
    },

    // Add notification
    addNotification(notification) {
      const id = Date.now() + Math.random()
      this.notifications.push({
        id,
        ...notification,
        timestamp: Date.now(),
      })

      // Keep only last 5 notifications
      if (this.notifications.length > 5) {
        this.notifications = this.notifications.slice(-5)
      }

      // Play sound if enabled
      if (this.notificationSettings.soundEnabled) {
        this.playNotificationSound()
      }
    },

    // Dismiss notification
    dismissNotification(id) {
      this.notifications = this.notifications.filter((n) => n.id !== id)
    },

    // Play notification sound
    playNotificationSound() {
      try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)()
        const oscillator = audioContext.createOscillator()
        const gainNode = audioContext.createGain()
        oscillator.connect(gainNode)
        gainNode.connect(audioContext.destination)
        oscillator.frequency.value = 440
        oscillator.type = "sine"
        gainNode.gain.value = 0.1
        oscillator.start()
        oscillator.stop(audioContext.currentTime + 0.1)
      } catch {
        // Ignore audio errors
      }
    },

    // Load recent logs from server
    async loadRecentLogs() {
      try {
        const { data } = await this.requestJson("/api/logs/recent?limit=100")
        if (data.status === "ok" && data.logs) {
          this.logs = data.logs
        }
      } catch (error) {
        console.error("Failed to load recent logs:", error)
      }
    },

    // Toggle pause
    toggleLogsPause() {
      this.logsPaused = !this.logsPaused
      if (!this.logsPaused) {
        this.showToast("Log streaming resumed", "info")
      } else {
        this.showToast("Log streaming paused", "info")
      }
    },

    // Clear logs
    clearLogs() {
      this.logs = []
    },

    // Export logs as JSON
    exportLogs() {
      const logsToExport = this.filteredLogs
      const blob = new Blob([JSON.stringify(logsToExport, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `copilot-api-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      this.showToast(`Exported ${logsToExport.length} logs`, "success")
    },

    // Export logs as CSV
    exportLogsCSV() {
      const logsToExport = this.filteredLogs
      // CSV header
      const header = "Timestamp,Level,Message\n"
      // CSV rows
      const rows = logsToExport.map((log) => {
        const timestamp = new Date(log.timestamp).toISOString()
        const level = log.level
        // Escape quotes in message and wrap in quotes
        const message = `"${(log.message || "").replace(/"/g, '""')}"`
        return `${timestamp},${level},${message}`
      }).join("\n")

      const csv = header + rows
      const blob = new Blob([csv], { type: "text/csv" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `copilot-api-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      this.showToast(`Exported ${logsToExport.length} logs as CSV`, "success")
    },

    // Get filtered logs
    get filteredLogs() {
      let filtered = this.logs

      if (this.logsErrorsOnly) {
        filtered = filtered.filter((log) => log.level === "error")
      }

      // Filter by level
      if (!this.logsErrorsOnly && this.logsFilter !== "all") {
        filtered = filtered.filter((log) => log.level === this.logsFilter)
      }

      // Filter by search
      if (this.logsSearch.trim()) {
        const search = this.logsSearch.toLowerCase()
        filtered = filtered.filter(
          (log) =>
            log.message.toLowerCase().includes(search) ||
            log.level.toLowerCase().includes(search)
        )
      }

      // Filter by date range
      if (this.logsDateFrom) {
        const fromDate = new Date(this.logsDateFrom).getTime()
        filtered = filtered.filter((log) => new Date(log.timestamp).getTime() >= fromDate)
      }
      if (this.logsDateTo) {
        const toDate = new Date(this.logsDateTo).getTime()
        filtered = filtered.filter((log) => new Date(log.timestamp).getTime() <= toDate)
      }

      return filtered
    },

    // Update usage chart
    updateChart() {
      const ctx = document.querySelector("#usageChart")
      if (!ctx) return

      const entries = Object.entries(this.usageStats.byModel || {})
      const labels = entries.map(([model]) => model)
      const data = entries.map(([, count]) => count)
      const total = this.usageStats.totalRequests || 0

      if (this.usageChart) {
        this.usageChart.destroy()
      }

      if (this.chartType === "bar") {
        // Bar chart configuration
        const backgroundColors = data.map(count => {
          const percent = total > 0 ? count / total : 0
          if (percent > 0.4) return 'rgba(34, 211, 238, 0.7)' // neon-cyan for high usage
          if (percent > 0.2) return 'rgba(168, 85, 247, 0.7)' // neon-purple for medium usage
          return 'rgba(168, 85, 247, 0.4)' // lighter purple for low usage
        })

        const borderColors = data.map(count => {
          const percent = total > 0 ? count / total : 0
          if (percent > 0.4) return 'rgba(34, 211, 238, 1)'
          if (percent > 0.2) return 'rgba(168, 85, 247, 1)'
          return 'rgba(168, 85, 247, 0.6)'
        })

        this.usageChart = new Chart(ctx, {
          type: "bar",
          data: {
            labels: labels,
            datasets: [
              {
                label: "Requests",
                data: data,
                backgroundColor: backgroundColors,
                borderColor: borderColors,
                borderWidth: 2,
                borderRadius: 6,
                borderSkipped: false,
                hoverBackgroundColor: 'rgba(34, 211, 238, 0.9)',
                hoverBorderColor: 'rgba(34, 211, 238, 1)',
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
              duration: 800,
              easing: 'easeOutQuart'
            },
            plugins: {
              legend: {
                display: false,
              },
              tooltip: {
                backgroundColor: 'rgba(15, 15, 26, 0.95)',
                titleColor: '#ffffff',
                bodyColor: '#a1a1aa',
                borderColor: 'rgba(168, 85, 247, 0.5)',
                borderWidth: 1,
                cornerRadius: 8,
                padding: 12,
                displayColors: false,
                callbacks: {
                  label: function(context) {
                    const value = context.raw
                    const total = context.dataset.data.reduce((a, b) => a + b, 0)
                    const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0
                    return [
                      `${value} requests`,
                      `${percent}% of total`
                    ]
                  },
                  title: function(context) {
                    return context[0].label
                  }
                }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                grid: {
                  color: "rgba(255, 255, 255, 0.05)",
                  drawBorder: false,
                },
                ticks: {
                  color: "rgba(255, 255, 255, 0.4)",
                  font: {
                    size: 11,
                    family: "'Inter', system-ui, sans-serif"
                  },
                  padding: 8,
                },
              },
              x: {
                grid: {
                  display: false,
                },
                ticks: {
                  color: "rgba(255, 255, 255, 0.4)",
                  font: {
                    size: 11,
                    family: "'JetBrains Mono', 'Fira Code', monospace"
                  },
                  maxRotation: 45,
                  minRotation: 30,
                  padding: 8,
                },
              },
            },
            interaction: {
              intersect: false,
              mode: 'index',
            },
          },
        })
      } else if (this.chartType === "doughnut") {
        // Doughnut chart configuration
        const neonColors = [
          'rgba(34, 211, 238, 0.8)',  // neon-cyan
          'rgba(168, 85, 247, 0.8)',  // neon-purple
          'rgba(34, 197, 94, 0.8)',   // neon-green
          'rgba(251, 191, 36, 0.8)',  // amber
          'rgba(239, 68, 68, 0.8)',   // red
          'rgba(59, 130, 246, 0.8)',  // blue
          'rgba(236, 72, 153, 0.8)',  // pink
          'rgba(139, 92, 246, 0.8)',  // violet
        ]

        const borderColors = [
          'rgba(34, 211, 238, 1)',
          'rgba(168, 85, 247, 1)',
          'rgba(34, 197, 94, 1)',
          'rgba(251, 191, 36, 1)',
          'rgba(239, 68, 68, 1)',
          'rgba(59, 130, 246, 1)',
          'rgba(236, 72, 153, 1)',
          'rgba(139, 92, 246, 1)',
        ]

        const backgroundColors = data.map((_, i) => neonColors[i % neonColors.length])
        const doughnutBorderColors = data.map((_, i) => borderColors[i % borderColors.length])

        this.usageChart = new Chart(ctx, {
          type: "doughnut",
          data: {
            labels: labels,
            datasets: [
              {
                label: "Requests",
                data: data,
                backgroundColor: backgroundColors,
                borderColor: doughnutBorderColors,
                borderWidth: 2,
                hoverBackgroundColor: backgroundColors.map(c => c.replace('0.8', '1')),
                hoverBorderColor: doughnutBorderColors,
                hoverBorderWidth: 3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
              duration: 800,
              easing: 'easeOutQuart'
            },
            cutout: '60%',
            plugins: {
              legend: {
                display: true,
                position: 'right',
                labels: {
                  color: 'rgba(255, 255, 255, 0.7)',
                  font: {
                    size: 11,
                    family: "'Inter', system-ui, sans-serif"
                  },
                  padding: 12,
                  usePointStyle: true,
                  pointStyle: 'circle',
                  generateLabels: function(chart) {
                    const data = chart.data
                    if (data.labels.length && data.datasets.length) {
                      return data.labels.map((label, i) => {
                        const value = data.datasets[0].data[i]
                        const total = data.datasets[0].data.reduce((a, b) => a + b, 0)
                        const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0
                        return {
                          text: `${label} (${percent}%)`,
                          fillStyle: data.datasets[0].backgroundColor[i],
                          hidden: false,
                          index: i
                        }
                      })
                    }
                    return []
                  }
                }
              },
              tooltip: {
                backgroundColor: 'rgba(15, 15, 26, 0.95)',
                titleColor: '#ffffff',
                bodyColor: '#a1a1aa',
                borderColor: 'rgba(168, 85, 247, 0.5)',
                borderWidth: 1,
                cornerRadius: 8,
                padding: 12,
                displayColors: true,
                callbacks: {
                  label: function(context) {
                    const value = context.raw
                    const total = context.dataset.data.reduce((a, b) => a + b, 0)
                    const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0
                    return `${value} requests (${percent}%)`
                  }
                }
              }
            },
            interaction: {
              intersect: false,
              mode: 'nearest',
            },
          },
        })
      }
    },

    // Show toast notification
    showToast(message, type = "info") {
      this.toast = { show: true, message, type }
      setTimeout(() => {
        this.toast.show = false
      }, 3000)
    },

    // Format uptime
    formatUptime(seconds) {
      if (!seconds) return "0s"

      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)

      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${minutes}m`
      return `${minutes}m`
    },

    // Get filtered models based on filter
    get filteredModels() {
      let result = this.models

      // Apply vendor filter
      if (this.modelFilter === "all") {
        result = this.models
      } else {
        result = this.models.filter((model) => {
          const id = model.id.toLowerCase()
          const vendor = (model.vendor || "").toLowerCase()

          switch (this.modelFilter) {
            case "openai":
              return (
                vendor.includes("openai")
                || id.includes("gpt")
                || id.includes("o1")
                || id.includes("o3")
                || id.includes("o4")
              )
            case "anthropic":
              return vendor.includes("anthropic") || id.includes("claude")
            case "google":
              return (
                vendor.includes("google") || id.includes("gemini")
              )
            case "other":
              return (
                !vendor.includes("openai")
                && !vendor.includes("anthropic")
                && !vendor.includes("google")
                && !id.includes("gpt")
                && !id.includes("o1")
                && !id.includes("o3")
                && !id.includes("o4")
                && !id.includes("claude")
                && !id.includes("gemini")
              )
            default:
              return true
          }
        })
      }

      // Apply search filter
      if (this.modelSearch && this.modelSearch.trim()) {
        const search = this.modelSearch.toLowerCase().trim()
        result = result.filter((model) => {
          const id = (model.id || "").toLowerCase()
          const name = (model.name || "").toLowerCase()
          const vendor = (model.vendor || "").toLowerCase()
          const family = (model.capabilities?.family || "").toLowerCase()
          const type = (model.capabilities?.type || "").toLowerCase()
          
          return (
            id.includes(search) ||
            name.includes(search) ||
            vendor.includes(search) ||
            family.includes(search) ||
            type.includes(search)
          )
        })
      }

      return result
    },

    // Get model token limit (handles both flat and nested structure)
    getModelLimit(model, limitName) {
      const caps = model.capabilities
      if (!caps) return null
      // Try nested structure first (limits.maxContextTokens)
      if (caps.limits && caps.limits[limitName] !== undefined) {
        return caps.limits[limitName]
      }
      // Fallback to flat structure (maxContextTokens directly on capabilities)
      if (caps[limitName] !== undefined) {
        return caps[limitName]
      }
      return null
    },

    // Check if model supports a capability (handles both flat and nested structure)
    modelSupports(model, capability) {
      const caps = model.capabilities
      if (!caps) return false
      // Try nested structure first (supports.toolCalls)
      if (caps.supports && caps.supports[capability] !== undefined) {
        return caps.supports[capability]
      }
      // Fallback to flat structure (supportsToolCalls directly on capabilities)
      const flatName = "supports" + capability.charAt(0).toUpperCase() + capability.slice(1)
      if (caps[flatName] !== undefined) {
        return caps[flatName]
      }
      return false
    },

    // Format number
    formatNumber(num) {
      if (!num) return "N/A"
      if (num >= 1000000) return (num / 1000000).toFixed(1) + "M"
      if (num >= 1000) return (num / 1000).toFixed(1) + "K"
      return num.toString()
    },

    get avgRequestsPerMinute() {
      const total = this.usageStats.totalRequests || 0
      return (total / 1440).toFixed(2)
    },

    get avgRequestsPerHour() {
      const total = this.usageStats.totalRequests || 0
      return Math.round(total / 24)
    },

    get sortedModels() {
      const entries = Object.entries(this.usageStats.byModel || {})
      if (entries.length === 0) return []
      return entries.sort((a, b) => b[1] - a[1])
    },

    get topModelUsage() {
      const entries = Object.entries(this.usageStats.byModel || {})
      if (entries.length === 0) {
        return { model: "N/A", count: 0, percent: 0 }
      }
      const [model, count] = entries.sort((a, b) => b[1] - a[1])[0]
      const total = this.usageStats.totalRequests || 0
      const percent = total > 0 ? Math.round((count / total) * 100) : 0
      return { model, count, percent }
    },

    get premiumQuotaSummary() {
      const accounts = this.accountPool.accounts || []
      if (accounts.length === 0) {
        return { text: "N/A", percent: null }
      }

      let remaining = 0
      let entitlement = 0
      let hasUnlimited = false
      let count = 0

      for (const account of accounts) {
        const premium = account?.quota?.premiumInteractions
        if (!premium) continue
        count++
        if (premium.unlimited) {
          hasUnlimited = true
          continue
        }
        remaining += premium.remaining ?? 0
        entitlement += premium.entitlement ?? 0
      }

      if (count === 0) {
        return { text: "N/A", percent: null }
      }

      if (hasUnlimited) {
        return { text: "Unlimited", percent: null }
      }

      const percent = entitlement > 0 ? Math.round((remaining / entitlement) * 100) : 0
      return { text: `${remaining} / ${entitlement}`, percent }
    },

    get usageAccountSummary() {
      const accounts = this.accountPool.accounts || []
      let active = 0
      let paused = 0
      let lowQuota = 0
      let noQuota = 0

      for (const account of accounts) {
        if (account.active && !account.paused) {
          active++
        }
        if (account.paused) {
          paused++
        }
        if (!account.quota) {
          noQuota++
          continue
        }

        if (this.isLowQuotaAccount(account)) {
          lowQuota++
        }
      }

      return {
        total: this.accountPool.configuredCount || accounts.length,
        active,
        paused,
        lowQuota,
        noQuota,
      }
    },

    get filteredPoolAccounts() {
      const accounts = this.accountPool.accounts || []
      if (this.accountPoolQuotaFilter === "low") {
        return accounts.filter((account) => this.isLowQuotaAccount(account))
      }
      if (this.accountPoolQuotaFilter === "not-low") {
        return accounts.filter((account) => !this.isLowQuotaAccount(account))
      }
      return accounts
    },

    get usageQuotaResetDate() {
      const accounts = this.accountPool.accounts || []
      const resetDate = accounts.map((account) => account?.quota?.resetDate).find(Boolean)
      if (resetDate) {
        return new Date(resetDate).toLocaleDateString()
      }
      if (this.copilotUsage.quota_reset_date) {
        return new Date(this.copilotUsage.quota_reset_date).toLocaleDateString()
      }
      return "N/A"
    },

    getEffectiveAccountQuotaPercent(account) {
      if (!account?.quota) return null

      const snapshots = [
        account.quota.chat,
        account.quota.completions,
        account.quota.premiumInteractions,
      ]

      const percents = snapshots
        .map((snapshot) => {
          if (!snapshot) return null
          if (snapshot.unlimited) return 100
          return typeof snapshot.percentRemaining === "number" ? snapshot.percentRemaining : null
        })
        .filter((percent) => percent !== null)

      if (percents.length === 0) return null
      return Math.round(Math.min(...percents))
    },

    isLowQuotaAccount(account) {
      const effectiveQuota = this.getEffectiveAccountQuotaPercent(account)
      return account?.pausedReason === "quota" || (effectiveQuota !== null && effectiveQuota <= 20)
    },

    getUsageStatusLabel(account) {
      if (account.paused) {
        return account.pausedReason === "quota" ? "Low Quota" : "Paused"
      }
      if (!account.active) {
        return "Inactive"
      }
      if (account.rateLimited) {
        return "Rate Limited"
      }
      return "Active"
    },

    getUsageStatusClass(account) {
      if (account.paused && account.pausedReason === "quota") {
        return "bg-orange-500/15 text-orange-300 border border-orange-500/30"
      }
      if (account.paused) {
        return "bg-gray-500/15 text-gray-300 border border-gray-500/30"
      }
      if (!account.active) {
        return "bg-red-500/15 text-red-300 border border-red-500/30"
      }
      if (account.rateLimited) {
        return "bg-yellow-500/15 text-yellow-300 border border-yellow-500/30"
      }
      return "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
    },

    // Get quota color class based on percentage
    getQuotaColor(snapshot) {
      if (!snapshot || snapshot.unlimited) return "text-emerald-400"
      const percent = snapshot.percent_remaining || 0
      if (percent > 50) return "text-emerald-400"
      if (percent > 20) return "text-yellow-400"
      return "text-red-400"
    },

    // Get quota bar color based on percentage
    getQuotaBarColor(snapshot) {
      if (!snapshot || snapshot.unlimited) return "bg-emerald-500"
      const percent = snapshot.percent_remaining || 0
      if (percent > 50) return "bg-emerald-500"
      if (percent > 20) return "bg-yellow-500"
      return "bg-red-500"
    },

    // Format quota display text
    formatQuota(snapshot) {
      if (!snapshot) return "N/A"
      if (snapshot.unlimited) return "Unlimited"
      return `${snapshot.remaining ?? 0} / ${snapshot.limit ?? 0}`
    },

    getAccountQuotaPercent(account) {
      if (account?.quota?.chat?.unlimited) return "Unlimited"
      const percent = account?.quota?.chat?.percentRemaining
      if (percent === null || percent === undefined) return "N/A"
      return `${Math.round(percent)}%`
    },

    getAccountQuotaClass(account) {
      if (account?.quota?.chat?.unlimited) return "text-emerald-400"
      const percent = account?.quota?.chat?.percentRemaining
      if (percent === null || percent === undefined) return "text-gray-400"
      if (percent > 50) return "text-emerald-400"
      if (percent > 20) return "text-yellow-400"
      return "text-red-400"
    },

    // Format date for display
    formatDate(dateStr) {
      if (!dateStr) return "N/A"
      const date = new Date(dateStr)
      return date.toLocaleDateString()
    },

    // Format access type for display
    formatAccessType(accessType) {
      if (!accessType) return "N/A"
      return accessType.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
    },

    // Format log timestamp
    formatLogTime(timestamp) {
      if (!timestamp) return ""
      const date = new Date(timestamp)
      return date.toLocaleTimeString()
    },

    // Format relative time (e.g., "2 minutes ago")
    formatRelativeTime(timestamp) {
      if (!timestamp) return "Never"
      const now = Date.now()
      const diff = now - timestamp
      const seconds = Math.floor(diff / 1000)
      const minutes = Math.floor(seconds / 60)
      const hours = Math.floor(minutes / 60)
      const days = Math.floor(hours / 24)

      if (days > 0) return `${days}d ago`
      if (hours > 0) return `${hours}h ago`
      if (minutes > 0) return `${minutes}m ago`
      if (seconds > 10) return `${seconds}s ago`
      return "Just now"
    },
    formatCommit(sha) {
      if (!sha) return ""
      return sha.slice(0, 8)
    },

    // Format timestamp for rate limit reset
    formatResetTime(timestamp) {
      if (!timestamp) return "N/A"
      const date = new Date(timestamp)
      const now = Date.now()
      if (timestamp <= now) return "Now"
      const diff = timestamp - now
      const minutes = Math.ceil(diff / 60000)
      if (minutes < 60) return `in ${minutes}m`
      const hours = Math.ceil(minutes / 60)
      return `in ${hours}h`
    },

    getHttpStatusClass(statusCode) {
      if (!statusCode) return "bg-space-800 text-gray-400"
      if (statusCode >= 200 && statusCode < 300) return "bg-neon-green/20 text-neon-green"
      if (statusCode >= 400 && statusCode < 500) return "bg-red-500/20 text-red-400"
      if (statusCode >= 500) return "bg-red-500/20 text-red-400"
      return "bg-yellow-500/20 text-yellow-400"
    },

    // Copy text to clipboard
    async copyToClipboard(text) {
      const normalizedText = String(text ?? "")
      try {
        if (window.isSecureContext && navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(normalizedText)
          this.showToast("Copied to clipboard!", "success")
          return
        }
      } catch (error) {
        console.error("Clipboard API failed:", error)
      }

      try {
        const textarea = document.createElement("textarea")
        textarea.value = normalizedText
        textarea.setAttribute("readonly", "")
        textarea.style.position = "fixed"
        textarea.style.top = "-9999px"
        textarea.style.left = "-9999px"
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        textarea.setSelectionRange(0, normalizedText.length)
        const ok = document.execCommand("copy")
        document.body.removeChild(textarea)
        if (ok) {
          this.showToast("Copied to clipboard!", "success")
          return
        }
      } catch (error) {
        console.error("Fallback copy failed:", error)
      }

      this.showToast(
        "Copy failed. Please copy manually from the code field.",
        "error",
      )
    },

    async copyUpdateCommand() {
      const command = this.versionCheck.updateCommand || "git pull origin main"
      await this.copyToClipboard(command)
    },

    async copyModelId(modelId) {
      await this.copyToClipboard(modelId)
    },

    // Check if account is current (being used)
    isCurrentAccount(accountId) {
      return this.accountPool.currentAccountId === accountId
    },

    // ==========================================
    // Request History Functions
    // ==========================================

    // Fetch request history
    async fetchRequestHistory() {
      try {
        const params = new URLSearchParams({
          limit: "50",
          offset: this.historyOffset.toString(),
        })
        if (this.historyFilter.model) params.set("model", this.historyFilter.model)
        if (this.historyFilter.status) params.set("status", this.historyFilter.status)
        if (this.historyFilter.accountId) params.set("account", this.historyFilter.accountId)

        const { data } = await this.requestJson(`/api/history?${params}`)
        if (data.status === "ok") {
          this.requestHistoryEntries = data.entries || []
          this.historyTotal = data.total || 0
          this.historyHasMore = data.hasMore || false
        }

        // Also fetch stats
        const { data: statsData } = await this.requestJson("/api/history/stats")
        if (statsData.status === "ok") {
          this.historyStats = statsData.stats || {}
        }
      } catch (error) {
        console.error("Failed to fetch request history:", error)
      }
    },

    // Clear request history
    async clearRequestHistory() {
      if (!confirm("Are you sure you want to clear all request history?")) return
      try {
        const { data } = await this.requestJson("/api/history", {
          method: "DELETE",
        })
        if (data.status === "ok") {
          this.requestHistoryEntries = []
          this.historyStats = {}
          this.historyTotal = 0
          this.showToast("Request history cleared", "success")
        }
      } catch (error) {
        this.showToast("Failed to clear history: " + error.message, "error")
      }
    },

    // ==========================================
    // API Playground Functions
    // ==========================================

    // Update playground request when model or stream changes
    updatePlaygroundRequest() {
      try {
        const current = JSON.parse(this.playground.request)
        current.model = this.playground.model
        current.stream = this.playground.stream
        this.playground.request = JSON.stringify(current, null, 2)
        this.playground.error = null
      } catch {
        // Ignore parse errors
      }
    },

    // Load a preset template
    loadPlaygroundPreset(preset) {
      const presets = {
        simple: {
          model: this.playground.model,
          messages: [
            { role: "user", content: "Hello! What can you help me with?" }
          ],
          stream: this.playground.stream,
        },
        system: {
          model: this.playground.model,
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello! What can you help me with?" }
          ],
          stream: this.playground.stream,
        },
        tools: {
          model: this.playground.model,
          messages: [
            { role: "user", content: "What's the weather in San Francisco?" }
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get the current weather for a location",
                parameters: {
                  type: "object",
                  properties: {
                    location: {
                      type: "string",
                      description: "City name"
                    }
                  },
                  required: ["location"]
                }
              }
            }
          ],
          stream: this.playground.stream,
        },
      }
      this.playground.request = JSON.stringify(presets[preset] || presets.simple, null, 2)
      this.playground.error = null
    },

    // Send playground request
    async sendPlaygroundRequest() {
      this.playground.loading = true
      this.playground.error = null
      this.playground.response = ""
      this.playground.duration = 0
      this.playground.statusCode = null
      this.playground.statusText = ""

      const startTime = Date.now()

      try {
        // Validate JSON
        let body
        try {
          body = JSON.parse(this.playground.request)
        } catch (e) {
          this.playground.error = "Invalid JSON: " + e.message
          return
        }

        const response = await fetch(this.playground.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        })
        this.playground.statusCode = response.status
        this.playground.statusText = response.statusText || ""
        if (response.status === 401) {
          this.handleAuthExpired()
          throw new Error("Authentication required")
        }
        if (!response.ok) {
          const text = await response.text()
          let message = text || `HTTP ${response.status}`

          if (text) {
            try {
              const parsed = JSON.parse(text)
              const parsedMessage = parsed?.error?.message || parsed?.message
              const parsedCode = parsed?.error?.code || parsed?.code

              if (typeof parsedMessage === "string" && parsedMessage.trim()) {
                message = parsedMessage
              }
              if (typeof parsedCode === "string" && parsedCode.trim()) {
                message = `${message} (${parsedCode})`
              }
            } catch {
              // Keep raw text fallback
            }
          }

          throw new Error(message)
        }

        this.playground.duration = Date.now() - startTime

        if (body.stream) {
          // Handle streaming response
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6)
                if (data === "[DONE]") continue
                try {
                  const parsed = JSON.parse(data)
                  // Extract content from streaming chunk
                  if (parsed.choices?.[0]?.delta?.content) {
                    this.playground.response += parsed.choices[0].delta.content
                  }
                } catch {
                  // Ignore parse errors for SSE
                }
              }
            }
          }
        } else {
          // Handle non-streaming response
          const data = await response.json()
          this.playground.response = data
        }
      } catch (error) {
        this.playground.error = "Request failed: " + error.message
      } finally {
        this.playground.loading = false
        this.playground.duration = Date.now() - startTime
      }
    },

    // Copy request as cURL
    async copyAsCurl() {
      try {
        const body = JSON.parse(this.playground.request)
        const curl = `curl -X POST '${window.location.origin}${this.playground.endpoint}' \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(body)}'`
        await navigator.clipboard.writeText(curl)
        this.showToast("cURL command copied to clipboard!", "success")
      } catch (error) {
        this.showToast("Failed to copy: " + error.message, "error")
      }
    },

    // ==========================================
    // Account Health Helper
    // ==========================================

    // Get account status color for health indicator
    getAccountStatusColor(account) {
      if (account.paused) return "gray"
      if (!account.active) return "red"
      const quota = account.quota?.chat?.percentRemaining || 0
      if (quota < 5) return "red"
      if (quota < 20) return "yellow"
      return "green"
    },
  }))
})
