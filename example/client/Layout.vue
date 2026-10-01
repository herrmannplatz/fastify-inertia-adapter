<script setup lang="ts">
import { Link, usePage } from '@inertiajs/vue3'

const page = usePage<{ appName: string }>()
</script>

<template>
  <nav style="display: flex; gap: 1rem; margin-bottom: 1rem">
    <strong>{{ page.props.appName }}</strong>
    <Link href="/">Home</Link>
    <Link href="/users">Users</Link>
    <Link href="/users/create">New user</Link>
  </nav>
  <p v-if="page.flash.success" style="color: green">{{ page.flash.success }}</p>
  <main><slot /></main>
</template>
